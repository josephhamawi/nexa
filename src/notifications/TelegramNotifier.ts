import { hasTelegramCredentials, loadEnv } from '../config/config';
import { childLogger } from '../logging/logger';

const log = childLogger('telegram');

export interface TelegramSendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Minimal Telegram Bot API client (sendMessage only) built on global fetch.
 *
 * The bot token is read from the environment at call time and never logged,
 * never persisted, and never included in an error message.
 */
export class TelegramNotifier {
  constructor(private readonly enabled: boolean) {}

  isConfigured(): boolean {
    return hasTelegramCredentials();
  }

  isReady(): boolean {
    return this.enabled && this.isConfigured();
  }

  async send(text: string): Promise<TelegramSendResult> {
    if (!this.enabled) return { ok: false, skipped: true, error: 'telegram disabled in config' };
    const env = loadEnv();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
    }

    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        const body = (await response.text().catch(() => '')).slice(0, 300);
        const message = `Telegram API returned ${response.status}: ${redactToken(body)}`;
        log.warn({ status: response.status }, 'telegram send failed');
        return { ok: false, error: message };
      }

      log.info('telegram notification sent');
      return { ok: true };
    } catch (err) {
      const message = redactToken((err as Error).message);
      log.warn({ err: message }, 'telegram send failed');
      return { ok: false, error: message };
    }
  }

  /** Verifies credentials without sending a chat message. */
  async verify(): Promise<TelegramSendResult & { botName?: string }> {
    const env = loadEnv();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`);
      if (!response.ok) return { ok: false, error: `getMe returned ${response.status}` };
      const body = (await response.json()) as { result?: { username?: string } };
      return { ok: true, botName: body.result?.username };
    } catch (err) {
      return { ok: false, error: redactToken((err as Error).message) };
    }
  }
}

/** Belt and braces: strip anything token-shaped out of outbound strings. */
function redactToken(text: string): string {
  return text.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-token]');
}
