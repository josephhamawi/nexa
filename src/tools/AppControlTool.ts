import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { AppControlConfig } from '../config/schema';
import { childLogger } from '../logging/logger';
import {
  APPLE_EVENT_TIMEOUT_SECONDS,
  explainAppleScriptError,
  requireMac,
  runOsascript,
  type ScriptRunner,
} from './applescript';

const log = childLogger('tool:app_control');

const InputSchema = z.object({
  /** The app to drive, by name as it appears in the Applications folder. */
  app: z.string().trim().min(1).max(100),
  /**
   * One AppleScript statement to run inside `tell application "<app>"`.
   *
   * Deliberately a fragment rather than a whole script: the tell block is
   * written here, so the statement cannot target a different app, and there is
   * nowhere to hang a second handler.
   */
  statement: z.string().trim().min(1).max(2000),
  /** Why this is being done, shown in the approval prompt. */
  reason: z.string().trim().max(300).default(''),
});

type Input = z.infer<typeof InputSchema>;

/**
 * AppleScript that reaches outside the app it claims to drive.
 *
 * `do shell script` is the one that matters. Without this check, an app tool
 * would be a complete bypass of the shell allow-list: "tell application
 * \\"Finder\\" to do shell script \\"...\\"" runs anything, and the careful list
 * of permitted programs would mean nothing. The rest close the same door by
 * other routes.
 */
const ESCAPES: { pattern: RegExp; what: string }[] = [
  { pattern: /\bdo\s+shell\s+script\b/i, what: 'do shell script' },
  { pattern: /\bsystem\s+attribute\b/i, what: 'system attribute' },
  { pattern: /\btell\s+application\b/i, what: 'a nested tell block' },
  { pattern: /\brun\s+script\b/i, what: 'run script' },
  { pattern: /\bopen\s+location\b/i, what: 'open location' },
  { pattern: /\bosascript\b/i, what: 'osascript' },
  { pattern: /\bcurrent\s+application\b/i, what: 'current application' },
  { pattern: /\bload\s+script\b/i, what: 'load script' },
];

/**
 * Drives another macOS app through AppleScript.
 *
 * This is the broadest capability Nexa has, which is why it is the most
 * constrained. An app allow-list decides what can be touched at all, and the
 * statement is checked for the handful of AppleScript constructs that escape
 * the app you named -- `do shell script` above all, because an app tool that
 * permits it makes the shell allow-list decorative.
 *
 * It is not a sandbox, and should not be described as one. AppleScript inside
 * a permitted app can do whatever that app can do: an allow-listed Mail can
 * still send mail. The allow-list is a statement about which apps you are
 * willing to hand over, and the approval prompt is the per-action check.
 */
export class AppControlTool implements Tool<Input> {
  readonly name = 'app_control';
  readonly description =
    'Drive another macOS app through AppleScript. Input: {app, statement, reason}. ' +
    '`app` must be one the user has allowed; `statement` is a single AppleScript statement run inside ' +
    'tell application "<app>" -- write the statement only, not the tell block. ' +
    'Shell escapes are refused. Prefer the dedicated calendar, notes and mail tools where they fit: ' +
    'they are safer, faster and give structured results.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.EXECUTE];
  readonly mutating = true;

  constructor(
    private readonly config: () => AppControlConfig,
    private readonly run: ScriptRunner = runOsascript,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const { enabled, allowedApps } = this.config();

    if (!enabled) {
      return {
        ok: false,
        summary: 'Controlling other apps is switched off',
        error: 'Turn on app control under Settings, and list the apps Nexa may drive.',
      };
    }

    const notMac = requireMac('Controlling other apps');
    if (notMac) return notMac;

    if (allowedApps.length === 0) {
      return {
        ok: false,
        summary: 'No apps are allowed yet',
        error: 'App control is on but no apps are listed, so nothing can be driven. Add them under Settings.',
      };
    }

    const app = allowedApps.find((name) => name.toLowerCase() === input.app.toLowerCase());
    if (!app) {
      return {
        ok: false,
        summary: `"${input.app}" is not on the allow-list`,
        error: `Nexa may drive: ${allowedApps.join(', ')}. Add "${input.app}" under Settings if you want it.`,
      };
    }

    const escape = ESCAPES.find((entry) => entry.pattern.test(input.statement));
    if (escape) {
      log.warn({ app, escape: escape.what }, 'refused an escaping statement');
      return {
        ok: false,
        summary: `That statement uses ${escape.what}, which is refused`,
        error:
          `${escape.what} reaches outside "${app}", which would make the allow-list meaningless. ` +
          'Use the shell tool for commands, or a dedicated tool for calendar, notes and mail.',
      };
    }

    try {
      // The app name is a script literal rather than an argv item because it
      // names the tell target, so it is taken from the allow-list entry and
      // never from the model's spelling of it.
      const script = [
        `with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds`,
        `\ttell application ${JSON.stringify(app)}`,
        `\t\t${input.statement}`,
        '\tend tell',
        'end timeout',
      ].join('\n');

      const output = (await this.run(script, [])).trim();

      context.report(`${app}: ${input.statement.slice(0, 60)}`);
      context.addEvidence({
        kind: 'data',
        title: `Drove ${app}`,
        summary: `${input.statement.slice(0, 160)} -> ${output.slice(0, 120) || 'no result'}`,
      });
      log.info({ app }, 'app statement run');

      return {
        ok: true,
        summary: output ? `${app} returned: ${output.slice(0, 160)}` : `${app} ran the statement`,
        data: { app, statement: input.statement, output },
      };
    } catch (err) {
      const message = (err as Error).message;

      const shared = explainAppleScriptError(message, app);
      if (shared) return shared;

      log.warn({ app, err: message }, 'app statement failed');
      return {
        ok: false,
        summary: `${app} could not run that`,
        error: message.slice(0, 400),
      };
    }
  }
}
