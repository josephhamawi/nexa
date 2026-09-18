import { TelegramNotifier } from './TelegramNotifier';
import { DesktopNotifier } from './DesktopNotifier';
import { SoundNotifier } from './SoundNotifier';
import type { AvailabilityResult } from '../availability/AvailabilityResult';
import { AvailabilityStatus, describeStatus } from '../availability/AvailabilityState';
import type { NotificationsConfig } from '../config/schema';
import { formatClock, formatDateLong } from '../utils/time';
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

const HEADER = '\u{1F1EA}\u{1F1F8} Spain\n\u{1F4CD} Lagos, Nigeria';

/** Fans a single event out to Telegram, the desktop and the speaker. */
export class NotificationManager {
  readonly telegram: TelegramNotifier;
  readonly desktop: DesktopNotifier;
  readonly sound: SoundNotifier;

  constructor(private config: NotificationsConfig) {
    this.telegram = new TelegramNotifier(config.telegram);
    this.desktop = new DesktopNotifier(config.desktop);
    this.sound = new SoundNotifier(config.sound);
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

  /** Appointment found: the alert this whole application exists for. */
  async appointmentFound(result: AvailabilityResult): Promise<NotificationOutcome> {
    const slot = result.appointments[0];
    const detectedAt = formatClock(new Date(result.checkedAt));
    const dateLine = slot ? formatDateLong(slot.date) : 'see the browser';
    const timeLine = slot?.time ?? '-';

    const extra =
      result.appointments.length > 1
        ? `\n\n+${result.appointments.length - 1} more slot${
            result.appointments.length > 2 ? 's' : ''
          } visible`
        : '';

    const telegramText =
      `\u{1F6A8} BLS SPAIN APPOINTMENT AVAILABLE\n\n` +
      `${HEADER}\n\n` +
      `Visa:\n${result.visaType}\n\n` +
      `Date:\n${dateLine}\n\n` +
      `Time:\n${timeLine}\n\n` +
      `Detected:\n${detectedAt}${extra}\n\n` +
      `The browser is open.\nComplete the booking manually.`;

    return this.dispatch({
      telegramText,
      desktopTitle: '\u{1F6A8} BLS Spain appointment available',
      desktopBody: `Lagos, Nigeria\n${dateLine}${slot?.time ? `, ${slot.time}` : ''}\n\nOpen the browser to continue.`,
      urgent: true,
      soundRepeats: 5,
    });
  }

  /** CAPTCHA, login or MFA: the user has to take over the browser. */
  async manualActionRequired(result: AvailabilityResult): Promise<NotificationOutcome> {
    const isLogin =
      result.status === AvailabilityStatus.LOGIN_REQUIRED ||
      result.status === AvailabilityStatus.SESSION_EXPIRED;

    const headline = isLogin
      ? '\u{1F1EA}\u{1F1F8} BLS Spain Lagos requires login.'
      : '⚠ BLS Spain Lagos needs human verification.';

    const telegramText =
      `${headline}\n\n` +
      `${HEADER}\n\n` +
      `${result.message}\n\n` +
      `Monitoring is paused.\n` +
      `Complete the step in Chromium, then press RESUME MONITORING.`;

    return this.dispatch({
      telegramText,
      desktopTitle: isLogin ? 'BLS Spain: login required' : 'BLS Spain: verification required',
      desktopBody: `Lagos, Nigeria\n${result.message}\n\nMonitoring is paused.`,
      urgent: true,
      soundRepeats: 3,
    });
  }

  /** Repeated failures or a structure change that needs a human look. */
  async attentionRequired(title: string, detail: string): Promise<NotificationOutcome> {
    const telegramText = `⚠ ${title}\n\n${HEADER}\n\n${detail}`;
    return this.dispatch({
      telegramText,
      desktopTitle: `BLS Spain: ${title}`,
      desktopBody: detail,
      urgent: true,
      soundRepeats: 2,
    });
  }

  /** Low-priority status change: Telegram only, no sound. */
  async info(message: string): Promise<NotificationOutcome> {
    return this.dispatch({
      telegramText: `${HEADER}\n\n${message}`,
      desktopTitle: 'BLS Spain Lagos',
      desktopBody: message,
      urgent: false,
      soundRepeats: 0,
    });
  }

  async test(): Promise<NotificationOutcome> {
    return this.dispatch({
      telegramText:
        `✅ BLS Spain Lagos monitor test notification\n\n` +
        `${HEADER}\n\n` +
        `If you can read this, Telegram is configured correctly.\n` +
        `Sent at ${formatClock()}.`,
      desktopTitle: 'BLS Spain Lagos monitor',
      desktopBody: 'Test notification. Notifications are working.',
      urgent: false,
      soundRepeats: 1,
    });
  }

  describeResult(result: AvailabilityResult): string {
    return `${describeStatus(result.status)}: ${result.message}`;
  }

  private async dispatch(input: {
    telegramText: string;
    desktopTitle: string;
    desktopBody: string;
    urgent: boolean;
    soundRepeats: number;
  }): Promise<NotificationOutcome> {
    const [telegram, desktop, sound] = await Promise.all([
      this.telegram.send(input.telegramText),
      this.desktop.notify({
        title: input.desktopTitle,
        body: input.desktopBody,
        urgent: input.urgent,
      }),
      input.soundRepeats > 0 ? this.sound.alert(input.soundRepeats) : Promise.resolve(false),
    ]);

    log.info(
      { telegram: telegram.ok, desktop, sound },
      'notification dispatched',
    );

    return { telegram, desktop, sound };
  }
}
