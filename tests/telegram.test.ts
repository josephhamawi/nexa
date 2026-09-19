import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotifier } from '../src/notifications/TelegramNotifier';
import { NotificationManager } from '../src/notifications/NotificationManager';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubTelegram(ok: boolean, result: unknown = { message_id: 1 }) {
  const mock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok, result, description: ok ? undefined : 'Unauthorized for bot 123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY-XXXXXX' }),
    text: async () => '',
  }));
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe('sending', () => {
  it('posts to the configured chat', async () => {
    const mock = stubTelegram(true);
    const result = await new TelegramNotifier(true).send('hello');
    expect(result.ok).toBe(true);

    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendMessage');
    const body = JSON.parse(String(init.body));
    expect(body.text).toBe('hello');
    expect(body.chat_id).toBe(process.env.TELEGRAM_CHAT_ID);
  });

  it('sends to a specific chat when asked', async () => {
    const mock = stubTelegram(true);
    await new TelegramNotifier(true).send('hi', { chatId: '999' });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).chat_id).toBe('999');
  });

  it('attaches inline buttons for approvals', async () => {
    const mock = stubTelegram(true);
    await new TelegramNotifier(true).send('approve?', {
      buttons: [[{ text: 'Approve', data: 'approve:abc' }, { text: 'Reject', data: 'reject:abc' }]],
    });
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const keyboard = JSON.parse(String(init.body)).reply_markup.inline_keyboard;
    expect(keyboard[0][0]).toEqual({ text: 'Approve', callback_data: 'approve:abc' });
  });

  it('truncates past Telegram\'s 4096 character limit', async () => {
    const mock = stubTelegram(true);
    await new TelegramNotifier(true).send('x'.repeat(9000));
    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text.length).toBe(4096);
  });

  it('skips cleanly when disabled', async () => {
    const mock = stubTelegram(true);
    const result = await new TelegramNotifier(false).send('hello');
    expect(result.skipped).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  it('never leaks the token in an error', async () => {
    stubTelegram(false);
    const result = await new TelegramNotifier(true).send('hello');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('TEST-TOKEN-FOR-UNIT-TESTS');
    expect(result.error).toContain('[redacted-token]');
  });

  it('survives a network failure', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
    }) as unknown as typeof fetch;
    const result = await new TelegramNotifier(true).send('hello');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });
});

describe('receiving', () => {
  it('parses a normal message', async () => {
    stubTelegram(true, [
      { update_id: 7, message: { text: 'find me jobs', chat: { id: 42424242 }, from: { username: 'rami' }, message_id: 3 } },
    ]);
    const updates = await new TelegramNotifier(true).getUpdates(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ updateId: 7, chatId: '42424242', text: 'find me jobs', isCallback: false });
  });

  it('parses a button press as a callback', async () => {
    stubTelegram(true, [
      {
        update_id: 9,
        callback_query: { id: 'cb1', data: 'approve:task-1', from: { username: 'rami' }, message: { chat: { id: 42424242 } } },
      },
    ]);
    const updates = await new TelegramNotifier(true).getUpdates(0);
    expect(updates[0]).toMatchObject({ isCallback: true, text: 'approve:task-1', callbackId: 'cb1' });
  });

  it('drops updates with no usable content', async () => {
    stubTelegram(true, [{ update_id: 11, message: { chat: { id: 42424242 } } }]);
    expect(await new TelegramNotifier(true).getUpdates(0)).toHaveLength(0);
  });
});

describe('notification manager', () => {
  it('offers approve and reject buttons with the task id', async () => {
    const mock = stubTelegram(true);
    const manager = new NotificationManager({ telegram: true, desktop: false, sound: false, dailyBriefAt: '' });
    await manager.approvalNeeded({ taskName: 'Submit form', reason: 'It posts data', taskId: 'abc-123' });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.text).toContain('Approval needed');
    expect(body.reply_markup.inline_keyboard[0][0].callback_data).toBe('approve:abc-123');
  });

  it('offers open, resume and cancel when a human is needed', async () => {
    const mock = stubTelegram(true);
    const manager = new NotificationManager({ telegram: true, desktop: false, sound: false, dailyBriefAt: '' });
    await manager.humanNeeded({ taskName: 'Browse', reason: 'CAPTCHA appeared', taskId: 'xyz' });

    const [, init] = mock.mock.calls[0] as [string, RequestInit];
    const keyboard = JSON.parse(String(init.body)).reply_markup.inline_keyboard.flat();
    expect(keyboard.map((b: { callback_data: string }) => b.callback_data)).toEqual(['open:xyz', 'resume:xyz', 'cancel:xyz']);
  });

  it('reports channel status honestly', () => {
    const manager = new NotificationManager({ telegram: false, desktop: true, sound: false, dailyBriefAt: '' });
    expect(manager.status()).toEqual({ telegram: 'disabled', desktop: 'enabled', sound: 'disabled' });
  });
});
