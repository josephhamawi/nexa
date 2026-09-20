import path from 'node:path';
import fs from 'node:fs';
import { app, ipcMain, shell, dialog, type BrowserWindow } from 'electron';
import { ZodError } from 'zod';
import type { NexaAgent } from '../agent/NexaAgent';
import type { TelegramBot } from '../telegram/TelegramBot';
import {
  hasTelegramCredentials,
  loadConfig,
  loadEnv,
  paths,
  writeEnvValues,
} from '../config/config';
import { AppConfigSchema } from '../config/schema';
import { detectChats, explainTelegramError } from '../notifications/TelegramNotifier';
import { childLogger } from '../logging/logger';

const log = childLogger('ipc');

/**
 * The dashboard's entire surface onto the agent.
 *
 * Deliberately narrow: the renderer can ask Nexa to do things, but it cannot
 * touch the filesystem, the browser or the network directly. Secrets go in
 * through here and never come back out.
 */
export function registerIpc(
  agent: NexaAgent,
  bot: TelegramBot,
  getWindow: () => BrowserWindow | null,
): void {
  // ------------------------------------------------------------------ state
  ipcMain.handle('agent:state', () => agent.dashboardState());
  ipcMain.handle('agent:activity', () => agent.activity.recent(150));

  ipcMain.handle('agent:request', async (_event, text: unknown) => {
    if (typeof text !== 'string' || !text.trim()) {
      return { ok: false, error: 'Say what you need first.' };
    }
    try {
      const response = await agent.handleRequest(text, 'desktop', null);
      return {
        ok: true,
        text: response.text,
        task: response.task,
        clarifying: response.clarifying ?? null,
        state: agent.dashboardState(),
      };
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'request failed');
      return { ok: false, error: (err as Error).message };
    }
  });

  // ------------------------------------------------------------------ tasks
  ipcMain.handle('task:get', (_event, id: unknown) =>
    typeof id === 'string' ? agent.tasks.get(id) : undefined,
  );

  ipcMain.handle('task:pause', (_event, id: unknown) => {
    if (typeof id === 'string') agent.tasks.pause(id);
    return agent.dashboardState();
  });

  ipcMain.handle('task:resume', (_event, id: unknown) => {
    if (typeof id === 'string') agent.resumeTask(id);
    return agent.dashboardState();
  });

  ipcMain.handle('task:cancel', (_event, id: unknown) => {
    if (typeof id === 'string') agent.tasks.cancel(id);
    return agent.dashboardState();
  });

  ipcMain.handle('task:run', async (_event, id: unknown) => {
    if (typeof id === 'string') {
      agent.tasks.enqueue(id);
    }
    return agent.dashboardState();
  });

  ipcMain.handle('task:approve', (_event, payload: unknown) => {
    const { id, approved } = (payload ?? {}) as { id?: string; approved?: boolean };
    if (typeof id === 'string') agent.approve(id, Boolean(approved));
    return agent.dashboardState();
  });

  // --------------------------------------------------------------- watchers
  ipcMain.handle('watcher:setStatus', (_event, payload: unknown) => {
    const { id, status } = (payload ?? {}) as { id?: string; status?: 'ACTIVE' | 'PAUSED' };
    if (typeof id === 'string' && (status === 'ACTIVE' || status === 'PAUSED')) {
      agent.watchers.setStatus(id, status);
    }
    return agent.dashboardState();
  });

  ipcMain.handle('watcher:remove', (_event, id: unknown) => {
    if (typeof id === 'string') agent.watchers.remove(id);
    return agent.dashboardState();
  });

  ipcMain.handle('watcher:check', async (_event, id: unknown) => {
    if (typeof id === 'string') await agent.watchers.check(id);
    return agent.dashboardState();
  });

  // ---------------------------------------------------------------- browser
  ipcMain.handle('browser:open', async (_event, profileId: unknown) => {
    await agent.openBrowser(typeof profileId === 'string' ? profileId : 'default');
    return agent.dashboardState();
  });

  // --------------------------------------------------------------- evidence
  ipcMain.handle('evidence:open', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') return { ok: false, error: 'invalid path' };
    // Only files Nexa itself produced may be opened from the renderer.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(paths.evidence))) {
      return { ok: false, error: 'path is outside the evidence directory' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'evidence not found' };
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('evidence:openFolder', async () => {
    const error = await shell.openPath(paths.evidence);
    return error ? { ok: false, error } : { ok: true };
  });

  // ----------------------------------------------------------------- config
  ipcMain.handle('config:get', () => loadConfig(true));

  ipcMain.handle('config:save', (_event, patch: unknown) => {
    try {
      const current = loadConfig(true);
      const incoming = (patch ?? {}) as Record<string, Record<string, unknown>>;
      const merged = AppConfigSchema.parse({
        llm: { ...current.llm, ...(incoming.llm ?? {}) },
        telegram: { ...current.telegram, ...(incoming.telegram ?? {}) },
        agent: { ...current.agent, ...(incoming.agent ?? {}) },
        files: { ...current.files, ...(incoming.files ?? {}) },
        notifications: { ...current.notifications, ...(incoming.notifications ?? {}) },
        userProfile: { ...current.userProfile, ...(incoming.userProfile ?? {}) },
        browserProfiles: incoming.browserProfiles ?? current.browserProfiles,
      });
      const saved = agent.applyConfig(merged);
      bot.updateConfig(saved.telegram);
      return { ok: true, config: saved };
    } catch (err) {
      const error = describeValidationError(err);
      log.warn({ err: error }, 'config save rejected');
      return { ok: false, error };
    }
  });

  ipcMain.handle('config:pickFolder', async () => {
    const window = getWindow();
    if (!window) return { ok: false, error: 'no window' };
    const result = await dialog.showOpenDialog(window, {
      title: 'Choose a folder Nexa may read',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  // --------------------------------------------------------------- secrets
  /**
   * Credentials are write-only from the renderer's point of view: it can set
   * them and ask whether they exist, but never read them back.
   */
  ipcMain.handle('secrets:get', () => {
    const env = loadEnv();
    return {
      telegram: { configured: hasTelegramCredentials(env), chatId: env.TELEGRAM_CHAT_ID ?? '', tokenPresent: Boolean(env.TELEGRAM_BOT_TOKEN) },
      anthropic: { keyPresent: Boolean(env.ANTHROPIC_API_KEY) },
      openai: { keyPresent: Boolean(env.OPENAI_API_KEY), baseUrl: env.OPENAI_BASE_URL ?? '' },
      envPath: paths.env,
    };
  });

  /**
   * Finds the chat id by asking the bot who has messaged it. Uses the token in
   * the form if one was typed, otherwise the saved one.
   */
  ipcMain.handle('secrets:detectChat', async (_event, payload: unknown) => {
    const typed = (payload ?? {}) as { botToken?: unknown };
    const token =
      (typeof typed.botToken === 'string' && typed.botToken.trim()) || loadEnv().TELEGRAM_BOT_TOKEN || '';

    if (!token) return { ok: false, error: 'Paste the bot token first, or save it.' };

    const result = await detectChats(token);
    if (!result.ok) return { ok: false, error: explainTelegramError(String(result.error)) };

    if (!result.chats || result.chats.length === 0) {
      return {
        ok: false,
        error:
          'That bot has no messages yet. Open Telegram, find the bot by its @username, press Start ' +
          'or send it any message, then press Detect again.',
      };
    }

    return { ok: true, chats: result.chats };
  });

  ipcMain.handle('secrets:saveTelegram', async (_event, payload: unknown) => {
    const input = (payload ?? {}) as { botToken?: unknown; chatId?: unknown };
    const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
    const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';

    if (!chatId) return { ok: false, error: 'Chat ID is required.' };
    if (!/^-?\d+$/.test(chatId)) return { ok: false, error: 'Chat ID must be numeric, e.g. 987654321.' };
    if (botToken && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      return { ok: false, error: 'That does not look like a bot token (123456789:AA...).' };
    }
    if (!botToken && !loadEnv().TELEGRAM_BOT_TOKEN) {
      return { ok: false, error: 'Bot token is required the first time.' };
    }

    try {
      writeEnvValues({ TELEGRAM_CHAT_ID: chatId, ...(botToken ? { TELEGRAM_BOT_TOKEN: botToken } : {}) });
    } catch (err) {
      return { ok: false, error: `Could not write ${paths.env}: ${(err as Error).message}` };
    }

    // Setting up a channel means wanting it on. Saving credentials only to be
    // told "telegram disabled in config" is a pointless extra step.
    const current = loadConfig(true);
    if (!current.notifications.telegram) {
      agent.applyConfig({ ...current, notifications: { ...current.notifications, telegram: true } });
      bot.updateConfig(loadConfig(true).telegram);
      log.info('telegram notifications enabled because credentials were saved');
    }

    // getMe only proves the token is real. Sending a message is what proves the
    // chat id is reachable, which is the half that usually goes wrong.
    const verified = await agent.notifications.telegram.verify();
    if (!verified.ok) {
      return { ok: true, verified: false, error: explainTelegramError(String(verified.error)) };
    }

    const delivered = await agent.notifications.telegram.send(
      `Nexa is connected${verified.botName ? ` via @${verified.botName}` : ''}. ` +
        'Send me something like "research the latest AI agent frameworks" to get started.',
    );

    if (!delivered.ok) {
      return {
        ok: true,
        verified: false,
        botName: verified.botName ?? null,
        error: explainTelegramError(String(delivered.error)),
      };
    }

    bot.start();
    return { ok: true, verified: true, botName: verified.botName ?? null };
  });

  ipcMain.handle('secrets:saveLlm', (_event, payload: unknown) => {
    const input = (payload ?? {}) as { provider?: unknown; apiKey?: unknown; baseUrl?: unknown };
    const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    const provider = input.provider === 'openai-compatible' ? 'openai-compatible' : 'anthropic';

    if (!apiKey) return { ok: false, error: 'An API key is required.' };

    try {
      if (provider === 'anthropic') writeEnvValues({ ANTHROPIC_API_KEY: apiKey });
      else {
        writeEnvValues({
          OPENAI_API_KEY: apiKey,
          ...(typeof input.baseUrl === 'string' && input.baseUrl ? { OPENAI_BASE_URL: input.baseUrl.trim() } : {}),
        });
      }
      // Re-create the provider so the new key takes effect immediately.
      agent.applyConfig(loadConfig(true));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle('notifications:test', async () => agent.notifications.test());

  // --------------------------------------------------------------- autostart
  /**
   * Starting at login is what makes a scheduler trustworthy: a watcher due
   * every six hours is useless if Nexa is only running when you remember to
   * open it.
   */
  ipcMain.handle('system:getAutostart', () => {
    const settings = app.getLoginItemSettings();
    return {
      enabled: settings.openAtLogin,
      // An unpackaged run would register the Electron binary, not Nexa.
      supported: app.isPackaged,
      reason: app.isPackaged ? '' : 'Available once you run the packaged Nexa.app.',
    };
  });

  ipcMain.handle('system:setAutostart', (_event, enabled: unknown) => {
    if (!app.isPackaged) {
      return { ok: false, error: 'Run the packaged Nexa.app to turn this on.' };
    }
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(enabled), openAsHidden: false });
      log.info({ enabled: Boolean(enabled) }, 'login item updated');
      return { ok: true, enabled: app.getLoginItemSettings().openAtLogin };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // ------------------------------------------------------------------- push
  const push = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  agent.on('state', (state) => push('agent:state', state));
  agent.on('activity', (entry) => push('agent:activity', entry));
  agent.on('task', () => push('agent:state', agent.dashboardState()));
  agent.on('watcher', () => push('agent:state', agent.dashboardState()));

  const attention = (): void => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.flashFrame(true);
  };

  agent.on('needs-human', attention);
  agent.on('needs-approval', attention);
  agent.on('completed', () => push('agent:state', agent.dashboardState()));
}

/** Zod's own message is a JSON dump; the dashboard shows one readable line. */
function describeValidationError(err: unknown): string {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    if (!issue) return 'That configuration is not valid.';
    const field = issue.path.join('.');
    return field ? `${field}: ${issue.message}` : issue.message;
  }
  return err instanceof Error ? err.message : String(err);
}
