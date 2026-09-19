/**
 * npm run doctor
 *
 * Read-only health check: what is configured, what is missing, what will and
 * will not work. Contacts nothing except Telegram's getMe, if configured.
 */
import { chromium } from 'playwright';
import {
  ensureDataDirs,
  hasLlmCredentials,
  hasTelegramCredentials,
  loadConfig,
  loadEnv,
  paths,
} from '../config/config';
import { NotificationManager } from '../notifications/NotificationManager';
import { JsonStore } from '../storage/JsonStore';
import type { Task } from '../tasks/Task';
import type { Watcher } from '../watchers/Watcher';

const OK = 'ok  ';
const BAD = 'FAIL';
const WARN = 'warn';

function line(label: string, mark: string, detail: string): void {
  console.log(`${mark}  ${label.padEnd(20)} ${detail}`);
}

async function main(): Promise<void> {
  ensureDataDirs();
  const env = loadEnv();
  const config = loadConfig();

  console.log('\nNexa doctor\n');

  try {
    line('Browser', OK, `Playwright Chromium at ${chromium.executablePath()}`);
  } catch (err) {
    line('Browser', BAD, `not installed, run "npx playwright install chromium" (${(err as Error).message})`);
  }

  const llmReady = hasLlmCredentials(config, env);
  line(
    'AI provider',
    llmReady ? OK : WARN,
    llmReady
      ? `${config.llm.provider}, model ${config.llm.model}`
      : `${config.llm.provider} configured but no key; Nexa will plan with rules`,
  );

  const telegramReady = hasTelegramCredentials(env);
  line('Telegram', telegramReady ? OK : WARN, telegramReady ? 'credentials present' : 'not configured, remote control is off');

  if (telegramReady) {
    const notifications = new NotificationManager(config.notifications);
    const verified = await notifications.telegram.verify();
    line('Telegram bot', verified.ok ? OK : BAD, verified.ok ? `@${verified.botName ?? 'bot'}` : String(verified.error));
  }

  const tasks = new JsonStore<Task>(paths.tasksFile);
  const watchers = new JsonStore<Watcher>(paths.watchersFile);
  line('Tasks stored', OK, `${tasks.size}`);
  line('Watchers stored', OK, `${watchers.size}`);

  line(
    'File access',
    config.files.allowedDirectories.length > 0 ? OK : WARN,
    config.files.allowedDirectories.length > 0
      ? `${config.files.allowedDirectories.length} folder(s) allowed`
      : 'no folders allowed, file tasks are disabled',
  );

  line('Demo mode', config.agent.demoMode ? WARN : OK, config.agent.demoMode ? 'ON, results are simulated' : 'off');
  line('Data directory', OK, paths.data);
  console.log('');
}

main().catch((err: Error) => {
  console.error(`doctor failed: ${err.message}`);
  process.exit(1);
});
