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
  secretsEncrypted,
} from '../config/config';
import { NotificationManager } from '../notifications/NotificationManager';
import { createLlmProvider } from '../llm/providers';
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

  // A key that is present but rejected is the failure worth catching here: it
  // looks identical to a working setup everywhere else, and Nexa silently
  // plans with rules instead.
  if (llmReady) {
    const provider = createLlmProvider(config, env);
    try {
      await provider.complete({ maxOutputTokens: 16, messages: [{ role: 'user', content: 'Say OK.' }] });
      line('AI provider call', OK, 'the model answered a test request');
    } catch (err) {
      line('AI provider call', BAD, `the model rejected a test request: ${(err as Error).message.slice(0, 180)}`);
    }
  }

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

  line(
    'Calendar',
    config.calendar.enabled ? OK : WARN,
    config.calendar.enabled
      ? `on, writing to "${config.calendar.defaultCalendar || 'no default set'}"`
      : 'off, calendar requests are declined',
  );

  line(
    'Notes',
    config.notes.enabled ? OK : WARN,
    config.notes.enabled ? `on, saving to "${config.notes.defaultFolder}"` : 'off, note requests are declined',
  );

  line(
    'Mail',
    config.mail.enabled ? OK : WARN,
    config.mail.enabled
      ? config.mail.allowSend
        ? 'on, reads the inbox and allowed to SEND as you'
        : 'on, reads the inbox, drafts only'
      : 'off, mail requests are declined',
  );

  const shell = config.automation.shell;
  line(
    'Run commands',
    shell.enabled ? (shell.allowedCommands.length > 0 ? OK : WARN) : OK,
    shell.enabled
      ? shell.allowedCommands.length > 0
        ? `on, allowed: ${shell.allowedCommands.join(', ')}`
        : 'on, but no commands are allowed so nothing can run'
      : 'off',
  );

  const apps = config.automation.apps;
  line(
    'Control other apps',
    apps.enabled ? (apps.allowedApps.length > 0 ? OK : WARN) : OK,
    apps.enabled
      ? apps.allowedApps.length > 0
        ? `on, allowed: ${apps.allowedApps.join(', ')}`
        : 'on, but no apps are allowed so nothing can be driven'
      : 'off',
  );

  const enabledServers = config.mcpServers.filter((server) => server.enabled);
  line(
    'MCP servers',
    OK,
    enabledServers.length > 0
      ? `${enabledServers.length} enabled: ${enabledServers.map((server) => server.id).join(', ')}`
      : `none enabled (${config.mcpServers.length} in the catalogue)`,
  );

  line(
    'Secrets at rest',
    secretsEncrypted() ? OK : WARN,
    secretsEncrypted()
      ? 'encrypted with the OS keychain'
      : `plaintext in ${paths.env} (owner-only). The desktop app encrypts them; this CLI cannot.`,
  );

  line('Demo mode', config.agent.demoMode ? WARN : OK, config.agent.demoMode ? 'ON, results are simulated' : 'off');
  line('Data directory', OK, paths.data);
  console.log('');
}

main().catch((err: Error) => {
  console.error(`doctor failed: ${err.message}`);
  process.exit(1);
});
