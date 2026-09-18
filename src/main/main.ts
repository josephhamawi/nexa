// Must come first: it redirects data/, config.json and .env into userData for
// packaged builds before any other module resolves a path.
import './appPaths';
import path from 'node:path';
import { app, BrowserWindow, shell } from 'electron';
import { ensureDataDirs, loadConfig, loadEnv } from '../config/config';
import { childLogger, logger } from '../logging/logger';
import { MonitorManager } from '../monitoring/MonitorManager';
import { registerIpc } from './ipc';

const log = childLogger('main');

let window: BrowserWindow | null = null;
let monitor: MonitorManager | null = null;

/** Single instance only, two dashboards would mean two monitoring loops. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  void bootstrap();
}

async function bootstrap(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  logger().info('BLS Spain Lagos monitor starting');

  await app.whenReady();

  const config = loadConfig();
  monitor = new MonitorManager(config);

  createWindow();
  registerIpc(monitor, () => window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 900,
    minHeight: 700,
    title: 'BLS Spain Appointment Monitor, Lagos',
    backgroundColor: '#0f1420',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const indexFile = path.join(__dirname, '..', 'ui', 'index.html');
  void window.loadFile(indexFile);

  window.once('ready-to-show', () => window?.show());

  /**
   * Without these, a dashboard that fails to load just shows the window's
   * background colour and looks like a hung black screen. That happens if the
   * app bundle is replaced while it is running (an upgrade over a live copy),
   * or if the renderer is killed for memory.
   */
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    log.error({ errorCode, errorDescription, url: validatedURL }, 'dashboard failed to load');
    void window?.webContents.loadURL(
      'data:text/html;charset=utf-8,' +
        encodeURIComponent(
          `<body style="font:14px ui-monospace,monospace;background:#f4f0e8;color:#1d1a16;padding:28px">
             <h2 style="margin:0 0 10px">Dashboard failed to load</h2>
             <p>${errorDescription} (${errorCode})</p>
             <p>If the application was updated while it was open, quit it completely and start it again.</p>
           </body>`,
        ),
    );
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error({ reason: details.reason }, 'renderer process gone, reloading');
    if (details.reason !== 'clean-exit') window?.webContents.reload();
  });

  window.webContents.on('unresponsive', () => log.warn('dashboard is unresponsive'));

  // External links open in the user's own browser, never inside the dashboard.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.on('closed', () => {
    window = null;
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void shutdown();
});

app.on('before-quit', () => {
  void shutdown();
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down');
  try {
    await monitor?.shutdown();
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'shutdown error');
  }
  app.quit();
}

process.on('uncaughtException', (err) => {
  log.error({ err: err.message, stack: err.stack }, 'uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  log.error({ reason: String(reason) }, 'unhandled rejection');
});
