import fs from 'node:fs';
import { hasTelegramCredentials, loadEnv } from '../config/config';
import { childLogger } from '../logging/logger';

const log = childLogger('telegram');

export interface TelegramSendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  messageId?: number;
}

export interface InlineButton {
  text: string;
  /** Callback payload, kept short: Telegram caps this at 64 bytes. */
  data: string;
}

export interface TelegramUpdate {
  updateId: number;
  chatId: string;
  /** Message text, or the callback payload when a button was pressed. */
  text: string;
  from: string;
  isCallback: boolean;
  callbackId?: string;
  messageId?: number;
}

/**
 * Telegram client: sending, receiving and inline buttons.
 *
 * The bot token is read from the environment at call time, never logged, and
 * scrubbed from any error text before it can reach a log or the UI.
 */
export class TelegramNotifier {
  constructor(private readonly enabled: boolean) {}

  isConfigured(): boolean {
    return hasTelegramCredentials();
  }

  isReady(): boolean {
    return this.enabled && this.isConfigured();
  }

  private credentials(): { token: string; chatId: string } | null {
    const env = loadEnv();
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null;
    return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }

  private async call(method: string, body: unknown, timeoutMs = 20_000): Promise<unknown> {
    const creds = this.credentials();
    if (!creds) throw new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`https://api.telegram.org/bot${creds.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await response.json()) as { ok: boolean; result?: unknown; description?: string };
      if (!json.ok) throw new Error(redactToken(json.description ?? `HTTP ${response.status}`));
      return json.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async send(text: string, options: { chatId?: string | null; buttons?: InlineButton[][] } = {}): Promise<TelegramSendResult> {
    if (!this.enabled) return { ok: false, skipped: true, error: 'telegram disabled in config' };
    const creds = this.credentials();
    if (!creds) return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };

    try {
      const result = (await this.call('sendMessage', {
        chat_id: options.chatId ?? creds.chatId,
        // Telegram rejects messages over 4096 characters outright.
        text: text.slice(0, 4096),
        disable_web_page_preview: true,
        ...(options.buttons ? { reply_markup: { inline_keyboard: toKeyboard(options.buttons) } } : {}),
      })) as { message_id?: number };
      log.info('telegram message sent');
      return { ok: true, messageId: result?.message_id };
    } catch (err) {
      const message = redactToken((err as Error).message);
      log.warn({ err: message }, 'telegram send failed');
      return { ok: false, error: message };
    }
  }

  /** Sends a screenshot as evidence alongside a caption. */
  async sendPhoto(filePath: string, caption: string, chatId?: string | null): Promise<TelegramSendResult> {
    if (!this.enabled) return { ok: false, skipped: true };
    const creds = this.credentials();
    if (!creds || !fs.existsSync(filePath)) return { ok: false, skipped: true };

    try {
      const form = new FormData();
      form.append('chat_id', chatId ?? creds.chatId);
      form.append('caption', caption.slice(0, 1024));
      form.append('photo', new Blob([fs.readFileSync(filePath)]), filePath.split('/').pop() ?? 'evidence.png');

      const response = await fetch(`https://api.telegram.org/bot${creds.token}/sendPhoto`, {
        method: 'POST',
        body: form,
      });
      const json = (await response.json()) as { ok: boolean; description?: string };
      if (!json.ok) throw new Error(redactToken(json.description ?? 'sendPhoto failed'));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: redactToken((err as Error).message) };
    }
  }

  /**
   * Long-polls for incoming messages and button presses.
   *
   * `offset` is the id after the last update Nexa handled; Telegram then drops
   * everything before it, which is what stops a restart replaying old commands.
   */
  async getUpdates(offset: number, timeoutSeconds = 25): Promise<TelegramUpdate[]> {
    if (!this.isReady()) return [];

    const result = (await this.call(
      'getUpdates',
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
      (timeoutSeconds + 10) * 1000,
    )) as RawUpdate[];

    return (result ?? []).map(toUpdate).filter((update): update is TelegramUpdate => update !== null);
  }

  /** Clears the spinner on a pressed inline button. */
  async acknowledgeCallback(callbackId: string, text = ''): Promise<void> {
    try {
      await this.call('answerCallbackQuery', { callback_query_id: callbackId, text: text.slice(0, 200) });
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'callback acknowledgement failed');
    }
  }

  async verify(): Promise<TelegramSendResult & { botName?: string }> {
    const creds = this.credentials();
    if (!creds) return { ok: false, skipped: true, error: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
    try {
      const result = (await this.call('getMe', {})) as { username?: string };
      return { ok: true, botName: result?.username };
    } catch (err) {
      return { ok: false, error: redactToken((err as Error).message) };
    }
  }
}

interface RawUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number }; from?: { username?: string; first_name?: string }; message_id?: number };
  callback_query?: {
    id: string;
    data?: string;
    from?: { username?: string; first_name?: string };
    message?: { chat?: { id?: number }; message_id?: number };
  };
}

function toUpdate(raw: RawUpdate): TelegramUpdate | null {
  if (raw.callback_query) {
    const chatId = raw.callback_query.message?.chat?.id;
    if (chatId === undefined) return null;
    return {
      updateId: raw.update_id,
      chatId: String(chatId),
      text: raw.callback_query.data ?? '',
      from: raw.callback_query.from?.username ?? raw.callback_query.from?.first_name ?? 'unknown',
      isCallback: true,
      callbackId: raw.callback_query.id,
      messageId: raw.callback_query.message?.message_id,
    };
  }

  const chatId = raw.message?.chat?.id;
  const text = raw.message?.text;
  if (chatId === undefined || !text) return null;

  return {
    updateId: raw.update_id,
    chatId: String(chatId),
    text,
    from: raw.message?.from?.username ?? raw.message?.from?.first_name ?? 'unknown',
    isCallback: false,
    messageId: raw.message?.message_id,
  };
}

function toKeyboard(buttons: InlineButton[][]): { text: string; callback_data: string }[][] {
  return buttons.map((row) => row.map((button) => ({ text: button.text, callback_data: button.data.slice(0, 64) })));
}

export interface DetectedChat {
  chatId: string;
  from: string;
  lastMessage: string;
}

/**
 * Reads the chat id straight out of the bot's own inbox.
 *
 * A private chat's id is just your Telegram user id, but it only exists once
 * you have messaged the bot. Asking the bot who has written to it is more
 * reliable than sending people to a third-party id bot, and it proves the
 * chat is reachable at the same time.
 */
export async function detectChats(token: string): Promise<{ ok: boolean; chats?: DetectedChat[]; error?: string }> {
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return { ok: false, error: 'That does not look like a bot token (123456789:AA...).' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // offset 0 so a previously-read backlog is still visible here.
      body: JSON.stringify({ offset: 0, limit: 20, allowed_updates: ['message'] }),
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout));

    const json = (await response.json()) as { ok: boolean; result?: RawUpdate[]; description?: string };
    if (!json.ok) return { ok: false, error: redactToken(json.description ?? 'Telegram refused the request') };

    const seen = new Map<string, DetectedChat>();
    for (const update of json.result ?? []) {
      const chatId = update.message?.chat?.id;
      if (chatId === undefined) continue;
      seen.set(String(chatId), {
        chatId: String(chatId),
        from: update.message?.from?.username ?? update.message?.from?.first_name ?? 'unknown',
        lastMessage: (update.message?.text ?? '').slice(0, 60),
      });
    }

    return { ok: true, chats: [...seen.values()] };
  } catch (err) {
    return { ok: false, error: redactToken((err as Error).message) };
  }
}

/**
 * Turns Telegram's terse API errors into the action that actually fixes them.
 *
 * "Bad Request: chat not found" is the common one and reads like a bug in the
 * app, when it only means the bot has never been spoken to from that chat.
 */
export function explainTelegramError(error: string): string {
  const lower = error.toLowerCase();

  if (lower.includes('chat not found')) {
    return (
      'Telegram says it cannot find that chat. Open Telegram, search for your bot by its @username, ' +
      'press Start (or send it any message), then save again. A bot cannot message you until you ' +
      'have messaged it first. Also check the chat ID belongs to the same account you messaged from.'
    );
  }
  if (lower.includes('unauthorized')) {
    return 'That bot token was rejected. Copy it again from @BotFather, it is the long 123456789:AA... string.';
  }
  if (lower.includes('blocked by the user')) {
    return 'You have blocked this bot in Telegram. Unblock it, then save again.';
  }
  if (lower.includes('deactivated')) {
    return 'That bot has been deleted in @BotFather. Create a new one and paste its token.';
  }
  if (lower.includes('too many requests') || lower.includes('retry after')) {
    return 'Telegram is rate limiting this bot. Wait a minute and try again.';
  }
  return error;
}

/** Belt and braces: strip anything token-shaped out of outbound strings. */
function redactToken(text: string): string {
  return text.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, '[redacted-token]');
}
