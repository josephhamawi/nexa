import { TelegramNotifier, type InlineButton } from './TelegramNotifier';
import { DesktopNotifier } from './DesktopNotifier';
import { SoundNotifier } from './SoundNotifier';
import type { NotificationsConfig } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('notifications');

export interface NotificationOutcome {
  telegram: { ok: boolean; skipped?: boolean; error?: string };
  desktop: boolean;
  sound: boolean;
}

export interface NotificationChannelStatus {
  telegram: 'connected' | 'not-configured' | 'disabled';
  desktop: 'enabled' | 'disabled';
  sound: 'enabled' | 'disabled';
}

/** Fans one event out to Telegram, the desktop and the speaker. */
export class NotificationManager {
  readonly telegram: TelegramNotifier;
  readonly desktop: DesktopNotifier;
  readonly sound: SoundNotifier;

  constructor(private config: NotificationsConfig) {
    this.telegram = new TelegramNotifier(config.telegram);
    this.desktop = new DesktopNotifier(config.desktop);
    this.sound = new SoundNotifier(config.sound);
  }

  updateConfig(config: NotificationsConfig): void {
    this.config = config;
  }

  status(): NotificationChannelStatus {
    return {
      telegram: !this.config.telegram
        ? 'disabled'
        : this.telegram.isConfigured()
          ? 'connected'
          : 'not-configured',
      desktop: this.config.desktop ? 'enabled' : 'disabled',
      sound: this.config.sound ? 'enabled' : 'disabled',
    };
  }

  /** A finished task's output. The everyday case, so no sound. */
  async report(input: { title: string; body: string; chatId?: string | null }): Promise<NotificationOutcome> {
    return this.dispatch({
      telegramText: `${input.title}\n\n${input.body}`,
      chatId: input.chatId ?? null,
      desktopTitle: input.title,
      desktopBody: input.body.slice(0, 220),
      urgent: false,
      soundRepeats: 0,
    });
  }

  /** Something needs a person. Worth making noise about. */
  async humanNeeded(input: {
    taskName: string;
    reason: string;
    taskId: string;
    chatId?: string | null;
  }): Promise<NotificationOutcome> {
    const buttons: InlineButton[][] = [
      [
        { text: 'Open browser', data: `open:${input.taskId}` },
        { text: 'Resume', data: `resume:${input.taskId}` },
      ],
      [{ text: 'Cancel task', data: `cancel:${input.taskId}` }],
    ];

    return this.dispatch({
      telegramText:
        `Nexa needs your help with "${input.taskName}".\n\n${input.reason}\n\n` +
        'Finish the step in the browser, then press Resume.',
      chatId: input.chatId ?? null,
      buttons,
      desktopTitle: 'Nexa needs your help',
      desktopBody: `${input.taskName}\n${input.reason}`,
      urgent: true,
      soundRepeats: 3,
    });
  }

  /** A consequential step is queued and waiting for a yes. */
  async approvalNeeded(input: {
    taskName: string;
    reason: string;
    taskId: string;
    chatId?: string | null;
  }): Promise<NotificationOutcome> {
    const buttons: InlineButton[][] = [
      [
        { text: 'Approve', data: `approve:${input.taskId}` },
        { text: 'Reject', data: `reject:${input.taskId}` },
      ],
    ];

    return this.dispatch({
      telegramText: `Approval needed for "${input.taskName}".\n\n${input.reason}`,
      chatId: input.chatId ?? null,
      buttons,
      desktopTitle: 'Nexa is waiting for approval',
      desktopBody: `${input.taskName}\n${input.reason}`,
      urgent: true,
      soundRepeats: 2,
    });
  }

  /** A watcher saw something change. */
  async watcherChanged(input: {
    watcherName: string;
    target: string;
    summary: string;
    chatId?: string | null;
  }): Promise<NotificationOutcome> {
    return this.dispatch({
      telegramText: `Change detected: ${input.watcherName}\n\n${input.target}\n\n${input.summary}`,
      chatId: input.chatId ?? null,
      desktopTitle: `Change: ${input.watcherName}`,
      desktopBody: input.summary.slice(0, 220),
      urgent: true,
      soundRepeats: 2,
    });
  }

  async taskFailed(input: { taskName: string; error: string; chatId?: string | null }): Promise<NotificationOutcome> {
    return this.dispatch({
      telegramText: `Task failed: ${input.taskName}\n\n${input.error}`,
      chatId: input.chatId ?? null,
      desktopTitle: `Nexa: ${input.taskName} failed`,
      desktopBody: input.error.slice(0, 220),
      urgent: true,
      soundRepeats: 1,
    });
  }

  async test(): Promise<NotificationOutcome> {
    return this.dispatch({
      telegramText:
        'Nexa test notification.\n\nIf you can read this, Telegram is wired up correctly. ' +
        'Send me something like "research the latest AI agent frameworks" to get started.',
      chatId: null,
      desktopTitle: 'Nexa',
      desktopBody: 'Test notification. Notifications are working.',
      urgent: false,
      soundRepeats: 1,
    });
  }

  private async dispatch(input: {
    telegramText: string;
    chatId: string | null;
    buttons?: InlineButton[][];
    desktopTitle: string;
    desktopBody: string;
    urgent: boolean;
    soundRepeats: number;
  }): Promise<NotificationOutcome> {
    const [telegram, desktop, sound] = await Promise.all([
      this.telegram.send(input.telegramText, {
        chatId: input.chatId,
        ...(input.buttons ? { buttons: input.buttons } : {}),
      }),
      this.desktop.notify({ title: input.desktopTitle, body: input.desktopBody, urgent: input.urgent }),
      input.soundRepeats > 0 ? this.sound.alert(input.soundRepeats) : Promise.resolve(false),
    ]);

    log.info({ telegram: telegram.ok, desktop, sound }, 'notification dispatched');
    return { telegram, desktop, sound };
  }
}
