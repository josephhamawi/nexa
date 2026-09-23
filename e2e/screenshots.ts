/**
 * Takes the screenshots the documentation uses.
 *
 * Separate from the end-to-end run on purpose. That one drives an empty app,
 * because an empty app is what a new user meets and its checks should not
 * depend on fixtures. This one seeds a plausible day's work first, because a
 * README showing five zeroes and "model: rules only" sells nothing.
 *
 * The data is invented but the rendering is not: every pixel here is the real
 * app reading a real state file, so these images go stale when the UI changes
 * rather than quietly misrepresenting it. Nothing belonging to the developer
 * is ever in frame -- it runs against a throwaway profile.
 */
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

function step(tool: string, description: string, status: string, output?: unknown, summary?: string) {
  return {
    id: `step-${Math.random().toString(36).slice(2, 10)}`,
    tool,
    description,
    input: {},
    status,
    startedAt: minutesAgo(12),
    finishedAt: status === 'DONE' ? minutesAgo(9) : null,
    output,
    summary: summary ?? null,
    error: null,
    attempts: 1,
  };
}

/** A day that looks like someone actually uses this. */
function sampleTasks(): unknown[] {
  return [
    {
      id: 'task-jobs',
      name: 'Remote AI engineering roles',
      description: 'Find and rank remote AI engineering roles',
      naturalLanguageRequest: 'find 5 remote AI engineering jobs that match my profile',
      type: 'RESEARCH',
      status: 'COMPLETED',
      phase: 'COMPLETED',
      progress: 100,
      createdAt: minutesAgo(30),
      lastRun: minutesAgo(9),
      nextRun: null,
      permissions: ['RESEARCH', 'READ', 'NOTIFY'],
      tools: ['web_research', 'analyze', 'notify'],
      recurrence: { kind: 'once' },
      approvalRequired: false,
      source: 'desktop',
      sourceChatId: null,
      updatedAt: minutesAgo(9),
      scheduledAt: null,
      plannedStepCount: 3,
      currentStepIndex: 3,
      resultData: null,
      approval: null,
      watcherId: null,
      owner: null,
      errors: [],
      evidence: [],
      confidence: {
        score: 82,
        level: 'high',
        summary: 'AI-planned, 9 sources read, strong match',
        factors: [
          { label: '9 sources read', delta: 18 },
          { label: 'strong match to the request', delta: 14 },
          { label: 'AI-planned', delta: 12 },
        ],
      },
      result:
        '5 roles matched your profile.\n\n' +
        '1. Senior AI Engineer — Anthropic\n' +
        '   Remote (US) · posted 2 days ago\n' +
        '   Agentic systems, evals, tool use. Matches: TypeScript, distributed systems.\n\n' +
        '2. Staff Engineer, Agents — Linear\n' +
        '   Remote (EU) · posted 4 days ago\n' +
        '   Matches: TypeScript, product engineering.\n\n' +
        '3. AI Platform Engineer — Vercel\n' +
        '   Remote · posted 1 day ago',
      steps: [
        step('web_research', 'Search for roles matching your profile', 'DONE', { findings: new Array(9).fill({}) }, '9 sources read'),
        step('analyze', 'Rank against your profile', 'DONE', { items: new Array(5).fill({}) }, '5 relevant results identified'),
        step('notify', 'Send the shortlist', 'DONE', { delivered: true }, 'Report sent to Telegram'),
      ],
    },
    {
      id: 'task-brief',
      name: 'Morning brief',
      description: 'Summarise what arrived overnight',
      naturalLanguageRequest: 'every weekday at 08:00, summarise what arrived overnight',
      type: 'REPORT',
      status: 'QUEUED',
      phase: 'WAITING',
      progress: 0,
      createdAt: minutesAgo(1400),
      lastRun: minutesAgo(1380),
      nextRun: new Date(Date.now() + 41 * 60_000).toISOString(),
      permissions: ['MAIL_READ', 'READ', 'NOTIFY'],
      tools: ['mail_read', 'analyze', 'notify'],
      recurrence: { kind: 'daily', at: '08:00' },
      approvalRequired: false,
      source: 'telegram',
      sourceChatId: null,
      updatedAt: minutesAgo(1380),
      scheduledAt: null,
      plannedStepCount: 3,
      currentStepIndex: 0,
      resultData: null,
      approval: null,
      watcherId: null,
      owner: null,
      errors: [],
      evidence: [],
      confidence: null,
      result: null,
      steps: [
        step('mail_read', 'Read what arrived overnight', 'PENDING'),
        step('analyze', 'Pull out what matters', 'PENDING'),
        step('notify', 'Send the brief', 'PENDING'),
      ],
    },
    {
      id: 'task-deploy',
      name: 'Release notes for v2.3',
      description: 'Draft release notes from the changelog',
      naturalLanguageRequest: 'draft release notes for v2.3 and save them to my notes',
      type: 'REPORT',
      status: 'WAITING_FOR_APPROVAL',
      phase: 'WAITING',
      progress: 66,
      createdAt: minutesAgo(18),
      lastRun: minutesAgo(3),
      nextRun: null,
      permissions: ['RESEARCH', 'READ', 'NOTES'],
      tools: ['web_research', 'analyze', 'notes'],
      recurrence: { kind: 'once' },
      approvalRequired: true,
      source: 'desktop',
      sourceChatId: null,
      updatedAt: minutesAgo(3),
      scheduledAt: null,
      plannedStepCount: 3,
      currentStepIndex: 2,
      resultData: null,
      approval: { reason: 'Saving a note changes something outside Nexa', requestedAt: minutesAgo(3), decidedAt: null, approved: null },
      watcherId: null,
      owner: null,
      errors: [],
      evidence: [],
      confidence: null,
      result: null,
      steps: [
        step('web_research', 'Read the changelog', 'DONE', { findings: new Array(3).fill({}) }, '3 sources read'),
        step('analyze', 'Group the changes by theme', 'DONE', { items: new Array(7).fill({}) }, '7 results ranked'),
        step('notes', 'Save the draft to Notes', 'PENDING'),
      ],
    },
  ];
}

/** Every field the Watcher interface declares, so startup does not trip. */
function watcher(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'w',
    name: 'Watcher',
    description: '',
    type: 'WEBSITE',
    target: 'https://example.com',
    selector: null,
    keywords: [],
    intervalSeconds: 21_600,
    status: 'ACTIVE',
    createdAt: minutesAgo(4000),
    lastChecked: null,
    lastChanged: null,
    nextCheck: null,
    currentState: null,
    previousState: null,
    changeSummary: null,
    consecutiveErrors: 0,
    lastError: null,
    notifyOnChange: true,
    browserProfileId: 'default',
    source: 'desktop',
    sourceChatId: null,
    ...over,
  };
}

function sampleWatchers(): unknown[] {
  return [
    watcher({
      id: 'watch-pricing',
      name: 'Watch anthropic.com/pricing',
      description: 'Tell me when pricing changes',
      target: 'https://www.anthropic.com/pricing',
      keywords: ['price', 'per million'],
      lastChecked: minutesAgo(52),
      lastChanged: minutesAgo(2880),
      nextCheck: new Date(Date.now() + 308 * 60_000).toISOString(),
      changeSummary: 'Sonnet input price changed',
    }),
    watcher({
      id: 'watch-jobs',
      name: 'Watch the careers page',
      description: 'New senior remote roles',
      type: 'JOB_SEARCH',
      target: 'https://jobs.example.com/engineering',
      keywords: ['remote', 'senior', 'AI'],
      intervalSeconds: 43_200,
      lastChecked: minutesAgo(140),
      nextCheck: new Date(Date.now() + 580 * 60_000).toISOString(),
    }),
  ];
}

function scratchProfile(): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-shots-'));
  const state = path.join(dir, 'data', 'state');
  fs.mkdirSync(state, { recursive: true });

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  config.userProfile = {
    ...(config.userProfile as Record<string, unknown>),
    name: 'Alex Rivera',
    summary: 'AI engineer building agentic systems',
    skills: ['TypeScript', 'Python', 'distributed systems'],
    technologies: ['Node', 'Playwright', 'Postgres'],
    preferredRoles: ['AI engineer', 'staff engineer'],
    remotePreference: 'remote',
    salaryMin: 180_000,
  };
  // Shown as enabled so the capability switches photograph as something a
  // person would actually set up.
  config.calendar = { enabled: true, defaultCalendar: 'Work' };
  config.notes = { enabled: true, defaultFolder: 'Notes' };
  config.mail = { enabled: true, allowSend: false, defaultAccount: '', accounts: ['Work', 'Personal'] };
  config.automation = {
    shell: { enabled: true, allowedCommands: ['git', 'ls', 'python3'], workingDirectory: '', timeoutSeconds: 60 },
    apps: { enabled: true, allowedApps: ['Finder', 'Safari'] },
  };

  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2));
  // Placeholder credentials so the header badges show a configured install
  // rather than "not set up". Nothing calls out: no task runs during a
  // screenshot pass, so these are never used for anything.
  fs.writeFileSync(
    path.join(dir, '.env'),
    ['NODE_ENV=test', 'LOG_LEVEL=error', 'ANTHROPIC_API_KEY=sk-ant-screenshot-placeholder', 'TELEGRAM_BOT_TOKEN=000:screenshot', 'TELEGRAM_CHAT_ID=1'].join('\n') + '\n',
  );
  fs.writeFileSync(path.join(state, 'tasks.json'), JSON.stringify(sampleTasks(), null, 2));
  fs.writeFileSync(path.join(state, 'watchers.json'), JSON.stringify(sampleWatchers(), null, 2));

  const activity = [
    { at: minutesAgo(9), level: 'success', message: 'Completed: Remote AI engineering roles (82% confidence)' },
    { at: minutesAgo(10), level: 'info', message: 'Report sent to Telegram' },
    { at: minutesAgo(11), level: 'info', message: '5 relevant results identified' },
    { at: minutesAgo(12), level: 'info', message: '9 sources read' },
    { at: minutesAgo(3), level: 'warn', message: 'Approval needed: saving a note changes something outside Nexa' },
    { at: minutesAgo(52), level: 'info', message: 'Checked anthropic.com/pricing — no meaningful change' },
  ]
    .map((entry, i) => JSON.stringify({ id: `act-${i}`, ...entry }))
    .join('\n');
  fs.writeFileSync(path.join(state, 'activity.jsonl'), `${activity}\n`);

  return {
    dir,
    env: {
      ...process.env,
      NEXA_DATA_DIR: path.join(dir, 'data'),
      NEXA_CONFIG_PATH: path.join(dir, 'config.json'),
      NEXA_ENV_PATH: path.join(dir, '.env'),
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      ANTHROPIC_API_KEY: 'sk-ant-screenshot-placeholder',
      TELEGRAM_BOT_TOKEN: '000:screenshot',
      TELEGRAM_CHAT_ID: '1',
    },
  };
}

async function main(): Promise<void> {
  const { dir, env } = scratchProfile();
  fs.mkdirSync(SHOTS, { recursive: true });

  let app: ElectronApplication | undefined;
  const taken: string[] = [];

  const shot = async (page: Page, name: string): Promise<void> => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    taken.push(name);
    console.log(`  ${name}.png`);
  };

  try {
    app = await electron.launch({ args: [path.join(ROOT, 'dist', 'main', 'main.js')], env, cwd: ROOT });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.panel', { timeout: 15_000 });

    await page.waitForTimeout(800);

    await shot(page, '01-overview');

    await page.locator('button.nav-item[data-view="tasks"]').click();
    await shot(page, '02-tasks');

    // The result dialog is the feature that is hardest to describe in words.
    const show = page.locator('button:has-text("Show")').first();
    if ((await show.count()) > 0) {
      await show.click();
      await page.waitForTimeout(500);
      await shot(page, '03-result');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    await page.locator('button.nav-item[data-view="watchers"]').click();
    await shot(page, '04-watchers');

    await page.locator('button.nav-item[data-view="approvals"]').click();
    await shot(page, '05-approvals');

    await page.locator('button.nav-item[data-view="settings"]').click();
    await shot(page, '06-settings');

    await page.locator('button.nav-item[data-view="overview"]').click();
    await page.locator('#command-input').fill('every weekday at 08:00, summarise what arrived overnight');
    await shot(page, '07-request');
  } finally {
    await app?.close().catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${taken.length} screenshots in ${path.relative(ROOT, SHOTS)}/`);
}

void main();
