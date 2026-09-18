import { execFile } from 'node:child_process';
import { childLogger } from '../logging/logger';

const log = childLogger('desktop-notify');

export interface DesktopNotification {
  title: string;
  body: string;
  urgent?: boolean;
}

/**
 * Desktop notifications without an extra dependency.
 *
 * Inside Electron the native Notification class is used. Outside it (the CLI
 * entry points) the platform's own notifier is invoked.
 */
export class DesktopNotifier {
  constructor(private readonly enabled: boolean) {}

  isReady(): boolean {
    return this.enabled;
  }

  async notify(notification: DesktopNotification): Promise<boolean> {
    if (!this.enabled) return false;

    if (this.notifyViaElectron(notification)) return true;

    try {
      await this.notifyViaPlatform(notification);
      return true;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'desktop notification failed');
      return false;
    }
  }

  private notifyViaElectron(notification: DesktopNotification): boolean {
    try {
      // Resolved lazily so the CLI never pulls Electron into a plain node process.
      const electron = require('electron') as typeof import('electron');
      if (!electron?.Notification || !electron.app?.isReady?.()) return false;
      if (!electron.Notification.isSupported()) return false;
      new electron.Notification({
        title: notification.title,
        body: notification.body,
        urgency: notification.urgent ? 'critical' : 'normal',
      }).show();
      return true;
    } catch {
      return false;
    }
  }

  private notifyViaPlatform(notification: DesktopNotification): Promise<void> {
    const { title, body } = notification;

    if (process.platform === 'darwin') {
      const script = `display notification ${quoteApplescript(body)} with title ${quoteApplescript(
        title,
      )}`;
      return run('osascript', ['-e', script]);
    }

    if (process.platform === 'linux') {
      return run('notify-send', [
        '-u',
        notification.urgent ? 'critical' : 'normal',
        title,
        body,
      ]);
    }

    if (process.platform === 'win32') {
      const ps = [
        '-NoProfile',
        '-Command',
        `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null;` +
          `$n = New-Object System.Windows.Forms.NotifyIcon;` +
          `$n.Icon = [System.Drawing.SystemIcons]::Information;` +
          `$n.BalloonTipTitle = ${quotePowershell(title)};` +
          `$n.BalloonTipText = ${quotePowershell(body)};` +
          `$n.Visible = $true; $n.ShowBalloonTip(10000); Start-Sleep -Seconds 6;`,
      ];
      return run('powershell', ps);
    }

    return Promise.reject(new Error(`unsupported platform: ${process.platform}`));
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function quoteApplescript(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function quotePowershell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
