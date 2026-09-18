import path from 'node:path';
import fs from 'node:fs';
import { ipcMain, shell, type BrowserWindow } from 'electron';
import type { MonitorManager } from '../monitoring/MonitorManager';
import {
  hasTelegramCredentials,
  loadConfig,
  loadEnv,
  paths,
  saveConfig,
  writeEnvValues,
} from '../config/config';
import { AppConfigSchema } from '../config/schema';
import { ZodError } from 'zod';
import { childLogger } from '../logging/logger';

const log = childLogger('ipc');

/**
 * Wires the dashboard to the monitor.
 *
 * The renderer can start, pause, resume, stop, check and open the browser -
 * it cannot drive the page, and there is deliberately no channel that books or
 * pays for anything.
 */
export function registerIpc(monitor: MonitorManager, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('monitor:getState', () => monitor.dashboardState());
  ipcMain.handle('monitor:getEvents', () => monitor.events.recent(120));

  ipcMain.handle('monitor:start', async () => {
    await monitor.start();
    return monitor.dashboardState();
  });

  ipcMain.handle('monitor:pause', () => {
    monitor.pause();
    return monitor.dashboardState();
  });

  ipcMain.handle('monitor:resume', async () => {
    await monitor.resume();
    return monitor.dashboardState();
  });

  ipcMain.handle('monitor:stop', async () => {
    await monitor.stop(false);
    return monitor.dashboardState();
  });

  ipcMain.handle('monitor:checkNow', async () => {
    const outcome = await monitor.checkNow();
    return { ...outcome, state: monitor.dashboardState() };
  });

  ipcMain.handle('monitor:openBrowser', async () => {
    await monitor.openBrowser();
    return monitor.dashboardState();
  });

  // Opens the portal's login page for a manual sign-in. There is deliberately
  // no channel that accepts credentials: nothing in this application types,
  // stores or reads a BLS password.
  ipcMain.handle('monitor:openLogin', async () => {
    await monitor.openLoginPage();
    return monitor.dashboardState();
  });

  ipcMain.handle('monitor:openScreenshot', async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string') return { ok: false, error: 'invalid path' };
    // Only files inside the project's screenshot directory may be opened.
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(paths.screenshots))) {
      return { ok: false, error: 'path outside the screenshot directory' };
    }
    if (!fs.existsSync(resolved)) return { ok: false, error: 'screenshot not found' };
    const error = await shell.openPath(resolved);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('monitor:openScreenshotFolder', async () => {
    const error = await shell.openPath(paths.screenshots);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle('config:get', () => loadConfig(true));

  ipcMain.handle('config:save', (_event, patch: unknown) => {
    try {
      const current = loadConfig(true);
      const incoming = (patch ?? {}) as { bls?: Record<string, unknown>; notifications?: Record<string, unknown> };
      const merged = AppConfigSchema.parse({
        bls: {
          ...current.bls,
          ...(incoming.bls ?? {}),
          // Lagos is not negotiable, whatever the renderer sends.
          country: 'Spain',
          applicationCountry: 'Nigeria',
          city: 'Lagos',
          centre: 'Lagos',
        },
        notifications: { ...current.notifications, ...(incoming.notifications ?? {}) },
      });
      const saved = saveConfig(merged);
      monitor.applyConfig(saved);
      return { ok: true, config: saved };
    } catch (err) {
      const error = describeValidationError(err);
      log.warn({ err: error }, 'config save rejected');
      return { ok: false, error };
    }
  });

  ipcMain.handle('options:get', () => monitor.formOptions());

  ipcMain.handle('options:refresh', async () => monitor.refreshFormOptions());

  /**
   * Telegram bot credentials.
   *
   * These belong to a bot you create for yourself, and the application needs
   * them to message you. The token is written to .env with owner-only
   * permissions, is never sent back to the renderer, and is never logged.
   * (Contrast with your BLS password, which the application never handles.)
   */
  ipcMain.handle('telegram:get', () => {
    const env = loadEnv();
    return {
      configured: hasTelegramCredentials(env),
      chatId: env.TELEGRAM_CHAT_ID ?? '',
      tokenPresent: Boolean(env.TELEGRAM_BOT_TOKEN),
      envPath: paths.env,
    };
  });

  ipcMain.handle('telegram:save', async (_event, payload: unknown) => {
    const input = (payload ?? {}) as { botToken?: unknown; chatId?: unknown };
    const chatId = typeof input.chatId === 'string' ? input.chatId.trim() : '';
    const botToken = typeof input.botToken === 'string' ? input.botToken.trim() : '';

    if (!chatId) return { ok: false, error: 'Chat ID is required.' };
    if (!/^-?\d+$/.test(chatId)) {
      return { ok: false, error: 'Chat ID must be numeric, e.g. 987654321.' };
    }
    if (botToken && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
      return { ok: false, error: 'That does not look like a bot token (123456789:AA...).' };
    }
    if (!botToken && !loadEnv().TELEGRAM_BOT_TOKEN) {
      return { ok: false, error: 'Bot token is required the first time.' };
    }

    try {
      const values: Record<string, string> = { TELEGRAM_CHAT_ID: chatId };
      if (botToken) values.TELEGRAM_BOT_TOKEN = botToken;
      writeEnvValues(values);
    } catch (err) {
      return { ok: false, error: `Could not write ${paths.env}: ${(err as Error).message}` };
    }

    // Re-create the notifier so it picks the new credentials up immediately.
    monitor.applyConfig(loadConfig(true));

    const verified = await monitor.notifications.telegram.verify();
    if (!verified.ok) {
      return { ok: true, saved: true, verified: false, error: verified.error };
    }
    return { ok: true, saved: true, verified: true, botName: verified.botName ?? null };
  });

  ipcMain.handle('notifications:test', async () => {
    const outcome = await monitor.notifications.test();
    return outcome;
  });

  const push = (channel: string, payload: unknown): void => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  };

  monitor.on('state', (state) => push('monitor:state', state));
  monitor.on('event', (event) => push('monitor:event', event));

  monitor.on('appointment-found', () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.flashFrame(true);
  });

  monitor.on('manual-action-required', () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.flashFrame(true);
  });
}

/**
 * Zod's own message is a JSON dump. The dashboard shows one readable line, so
 * an invalid setting tells you which field and why.
 */
function describeValidationError(err: unknown): string {
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    if (!issue) return 'That configuration is not valid.';
    const field = issue.path.filter((p) => p !== 'bls' && p !== 'notifications').join('.');
    return field ? `${field}: ${issue.message}` : issue.message;
  }
  return err instanceof Error ? err.message : String(err);
}
