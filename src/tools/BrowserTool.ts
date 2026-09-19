import { z } from 'zod';
import type { Page } from 'playwright';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { BrowserManager } from '../browser/BrowserManager';
import { capture, detectBlocking, redactQuery } from '../browser/ChallengeDetector';
import type { EvidenceStore } from '../evidence/EvidenceStore';
import type { BrowserProfile } from '../config/schema';
import { childLogger } from '../logging/logger';
import { sleep } from '../utils/time';

const log = childLogger('tool:browser');

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('goto'), url: z.string().url() }),
  z.object({ action: z.literal('click'), selector: z.string().min(1), optional: z.boolean().default(false) }),
  z.object({ action: z.literal('type'), selector: z.string().min(1), text: z.string() }),
  z.object({ action: z.literal('select'), selector: z.string().min(1), value: z.string() }),
  z.object({ action: z.literal('scroll'), pixels: z.number().int().default(800) }),
  z.object({ action: z.literal('wait'), seconds: z.number().min(0.5).max(30).default(2) }),
  z.object({ action: z.literal('extract'), selector: z.string().default('body'), label: z.string().default('content') }),
  z.object({ action: z.literal('screenshot'), label: z.string().default('page') }),
]);

export type BrowserAction = z.infer<typeof ActionSchema>;

const InputSchema = z.object({
  steps: z.array(ActionSchema).min(1),
  profileId: z.string().default('default'),
  /** Leave the browser open afterwards (needed for hand-over workflows). */
  keepOpen: z.boolean().default(true),
});

type Input = z.infer<typeof InputSchema>;

/**
 * Drives a real browser through a scripted workflow.
 *
 * Two rules shape this tool. It never tries to defeat a challenge: the moment
 * a CAPTCHA, login wall or block page appears it stops, screenshots, and asks
 * for a human. And it never types into a page it cannot see, so every action
 * is checked against the live DOM before it runs.
 */
export class BrowserTool implements Tool<Input> {
  readonly name = 'browser';
  readonly description =
    'Run a browser workflow: goto, click, type, select, scroll, wait, extract, screenshot. ' +
    'Input: {steps:[{action,...}], profileId}. Pauses for a human if a challenge or login appears.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.BROWSER];
  readonly mutating = true;

  constructor(
    private readonly browser: BrowserManager,
    private readonly evidence: EvidenceStore,
    private readonly resolveProfile: (id: string) => BrowserProfile,
    private readonly demoMode: () => boolean,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    if (this.demoMode()) {
      context.report('[demo] Browser workflow simulated, no site was contacted');
      await sleep(600);
      return {
        ok: true,
        summary: `[demo] Simulated ${input.steps.length} browser action(s)`,
        data: { simulated: true, extracted: {} },
      };
    }

    const profile = this.resolveProfile(input.profileId);
    const extracted: Record<string, string> = {};

    return this.browser.runOwned(async () => {
      const page = await this.browser.getPage(profile);

      for (const [index, step] of input.steps.entries()) {
        if (context.signal?.aborted) {
          return { ok: false, summary: 'Workflow cancelled', error: 'aborted' };
        }

        context.report(`Step ${index + 1}/${input.steps.length}: ${describe(step)}`);

        try {
          await this.runAction(page, step, context, extracted);
        } catch (err) {
          const shot = await this.evidence.screenshot(context.task.id, page, `failed-${step.action}`);
          context.addEvidence({
            kind: 'screenshot',
            path: shot,
            url: redactQuery(page.url()),
            title: await page.title().catch(() => null),
            summary: `Failed during ${describe(step)}`,
          });
          return {
            ok: false,
            summary: `Browser workflow failed at step ${index + 1} (${step.action})`,
            error: (err as Error).message,
          };
        }

        // After anything that can change the page, check for a wall.
        if (step.action === 'goto' || step.action === 'click') {
          const blocking = await this.checkForBlocking(page, context);
          if (blocking) return blocking;
        }
      }

      const shot = await this.evidence.screenshot(context.task.id, page, 'workflow-complete');
      context.addEvidence({
        kind: 'screenshot',
        path: shot,
        url: redactQuery(page.url()),
        title: await page.title().catch(() => null),
        summary: 'Workflow finished',
      });

      if (!input.keepOpen) await this.browser.close(profile.id);

      return {
        ok: true,
        summary: `Completed ${input.steps.length} browser action(s)`,
        data: { extracted, url: page.url(), text: Object.values(extracted).join('\n\n') },
      };
    });
  }

  private async runAction(
    page: Page,
    step: BrowserAction,
    context: ToolContext,
    extracted: Record<string, string>,
  ): Promise<void> {
    switch (step.action) {
      case 'goto':
        await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        return;

      case 'click': {
        const locator = page.locator(step.selector).first();
        const visible = await locator.isVisible({ timeout: 8000 }).catch(() => false);
        if (!visible) {
          if (step.optional) {
            log.debug({ selector: step.selector }, 'optional click target missing, skipping');
            return;
          }
          throw new Error(`nothing visible matched "${step.selector}"`);
        }
        await locator.click({ timeout: 15_000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
        return;
      }

      case 'type':
        await page.locator(step.selector).first().fill(step.text, { timeout: 15_000 });
        return;

      case 'select':
        await page.locator(step.selector).first().selectOption(step.value, { timeout: 15_000 });
        return;

      case 'scroll':
        await page.evaluate((pixels: number) => window.scrollBy(0, pixels), step.pixels);
        await sleep(500);
        return;

      case 'wait':
        await sleep(step.seconds * 1000);
        return;

      case 'extract': {
        const text = await page
          .locator(step.selector)
          .first()
          .innerText({ timeout: 15_000 })
          .catch(() => '');
        extracted[step.label] = text.slice(0, 20_000);
        context.addEvidence({
          kind: 'data',
          url: redactQuery(page.url()),
          title: step.label,
          summary: text.slice(0, 200).replace(/\s+/g, ' '),
        });
        return;
      }

      case 'screenshot': {
        const file = await this.evidence.screenshot(context.task.id, page, step.label);
        context.addEvidence({
          kind: 'screenshot',
          path: file,
          url: redactQuery(page.url()),
          title: await page.title().catch(() => null),
          summary: step.label,
        });
        return;
      }

      default:
        return;
    }
  }

  /**
   * Stops the workflow when the site asks for a human.
   *
   * No attempt is made to solve, submit or work around the challenge; the
   * browser is left exactly where it is so the user can take over.
   */
  private async checkForBlocking(page: Page, context: ToolContext): Promise<ToolResult | null> {
    const snapshot = await capture(page).catch(() => null);
    if (!snapshot) return null;

    const blocking = detectBlocking(snapshot);
    if (!blocking.detected) return null;

    const shot = await this.evidence.screenshot(context.task.id, page, `human-${blocking.kind.toLowerCase()}`);
    context.addEvidence({
      kind: 'screenshot',
      path: shot,
      url: redactQuery(snapshot.url),
      title: snapshot.title,
      summary: `${blocking.kind}: ${blocking.reason}`,
    });

    const human = {
      CAPTCHA: 'The site is asking for human verification.',
      LOGIN: 'The site needs you to sign in.',
      MFA: 'The site is asking for a one-time code.',
      SITE_ERROR: 'The site returned an error or is rate limiting.',
      NONE: 'The site needs attention.',
    }[blocking.kind];

    return {
      ok: false,
      summary: human,
      needsHuman: { reason: `${human} (${blocking.reason})`, url: snapshot.url },
    };
  }
}

function describe(step: BrowserAction): string {
  switch (step.action) {
    case 'goto':
      return `open ${new URL(step.url).host}`;
    case 'click':
      return `click ${step.selector}`;
    case 'type':
      return `type into ${step.selector}`;
    case 'select':
      return `choose "${step.value}"`;
    case 'scroll':
      return 'scroll';
    case 'wait':
      return `wait ${step.seconds}s`;
    case 'extract':
      return `extract ${step.label}`;
    case 'screenshot':
      return 'screenshot';
    default:
      return 'step';
  }
}
