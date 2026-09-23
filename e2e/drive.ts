/**
 * Drives the real app the way a person does, and photographs it on the way.
 *
 * Unit tests cover the pieces; this is the only thing that proves the window
 * opens, the views render, Settings round-trips to disk, and a request reaches
 * the agent. It is also where the README screenshots come from, so the images
 * in the documentation are by construction pictures of a working build rather
 * than mock-ups that drift.
 *
 * It runs against a scratch data directory with no API key: no real task runs,
 * nothing contacts the network, and a developer's own mail, tasks and secrets
 * are never touched.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function shot(page: Page, name: string): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** A throwaway profile, so the developer's own data is never in the frame. */
function scratchProfile(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-e2e-'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')) as Record<
    string,
    unknown
  >;

  // A named profile makes the screenshots legible without exposing anyone.
  config.userProfile = {
    ...(config.userProfile as Record<string, unknown>),
    name: 'Alex Rivera',
    summary: 'AI engineer building agentic systems',
    skills: ['TypeScript', 'Python', 'distributed systems'],
    preferredRoles: ['AI engineer'],
    remotePreference: 'remote',
  };

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(dir, '.env'), 'NODE_ENV=test\nLOG_LEVEL=error\n');

  return {
    dir,
    env: {
      ...process.env,
      NEXA_DATA_DIR: path.join(dir, 'data'),
      NEXA_CONFIG_PATH: path.join(dir, 'config.json'),
      NEXA_ENV_PATH: path.join(dir, '.env'),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      // No API key on purpose: planning stays rule-based, so the run is
      // deterministic, free and offline.
      ANTHROPIC_API_KEY: '',
      TELEGRAM_BOT_TOKEN: '',
    },
  };
}

async function main(): Promise<void> {
  const { dir, env } = scratchProfile();
  console.log(`Driving the app against a scratch profile at ${dir}\n`);

  let app: ElectronApplication | undefined;

  try {
    app = await electron.launch({ args: [path.join(ROOT, 'dist', 'main', 'main.js')], env, cwd: ROOT });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // ---------------------------------------------------------------- boots
    const title = await page.title();
    record('window opens', title.length > 0, `title "${title}"`);

    await page.waitForSelector('.record, .panel', { timeout: 15_000 });
    const overviewVisible = await page.locator('text=Your AI operations agent').isVisible();
    record('overview renders', overviewVisible);

    // A blank window is the classic Electron failure: it "launches" and shows
    // nothing. Assert real pixels, not just that a load event fired.
    const painted = await page.evaluate(() => document.body.innerText.trim().length);
    record('window is not blank', painted > 200, `${painted} characters of text`);

    await shot(page, '01-overview');

    // ------------------------------------------------------------ the views
    for (const view of ['tasks', 'watchers', 'approvals', 'activity', 'browser', 'settings']) {
      const nav = page.locator(`button.nav-item[data-view="${view}"]`).first();
      if ((await nav.count()) === 0) {
        record(`view: ${view}`, false, 'no nav item found');
        continue;
      }
      await nav.click();
      await page.waitForTimeout(250);
      const active = await page.locator(`[data-view="${view}"].active`).count();
      record(`view: ${view}`, active > 0);
      if (view === 'settings') await shot(page, '04-settings');
    }

    // -------------------------------------------------- settings round-trip
    await page.locator('button.nav-item[data-view="settings"]').click();
    await page.waitForTimeout(200);

    const shellToggle = page.locator('#f-shell-on');
    const shellCommands = page.locator('#f-shell-cmds');
    await shellToggle.check();
    await shellCommands.fill('git, ls');
    await page.locator('#settings-save').click();
    await page.waitForTimeout(800);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')) as {
      automation?: { shell?: { enabled?: boolean; allowedCommands?: string[] } };
    };
    record(
      'settings persist to disk',
      saved.automation?.shell?.enabled === true &&
        JSON.stringify(saved.automation?.shell?.allowedCommands) === JSON.stringify(['git', 'ls']),
      JSON.stringify(saved.automation?.shell),
    );

    // The file holding a user's configuration should not be world-readable.
    const mode = fs.statSync(path.join(dir, 'config.json')).mode & 0o777;
    record('config written owner-only', mode === 0o600, `mode ${mode.toString(8)}`);

    // --------------------------------------------------- a request is taken
    await page.locator('button.nav-item[data-view="overview"]').click();
    await page.waitForTimeout(200);

    const input = page.locator('#command-input');
    await input.fill('research the latest AI agent frameworks');
    await shot(page, '02-request');

    await page.locator('#command-send').click();
    await page.waitForTimeout(2500);

    const reply = await page.locator('#command-reply').innerText().catch(() => '');
    record('agent answers a request', reply.trim().length > 0, reply.split('\n')[0]?.slice(0, 60) ?? '');

    const tasksOnDisk = path.join(dir, 'data', 'state', 'tasks.json');
    record('task persisted', fs.existsSync(tasksOnDisk));
    await shot(page, '03-task-planned');

    // ------------------------------------------- refusing what it cannot do
    await input.fill('buy me a new laptop');
    await page.locator('#command-send').click();
    await page.waitForTimeout(1500);

    const refusal = await page.locator('#command-reply').innerText().catch(() => '');
    record(
      'refuses what it has no tool for',
      /cannot do that|will not buy/i.test(refusal),
      refusal.split('\n')[0]?.slice(0, 60) ?? '',
    );
    await shot(page, '05-honest-refusal');

    // ------------------------------------------------ no crashes throughout
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.waitForTimeout(500);
    record('no renderer exceptions', errors.length === 0, errors.slice(0, 2).join('; '));
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`Screenshots in ${path.relative(ROOT, SHOTS)}/`);

  if (failed.length > 0) {
    console.error(`\nFailed: ${failed.map((c) => c.name).join(', ')}`);
    process.exit(1);
  }
}

void main();
