import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramNotifier } from '../src/notifications/TelegramNotifier';
import { NotificationManager } from '../src/notifications/NotificationManager';
import { buildResult } from '../src/availability/AvailabilityResult';
import { AvailabilityStatus } from '../src/availability/AvailabilityState';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFetch(ok: boolean, body: unknown = { ok: true }): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 401,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('TelegramNotifier', () => {
  it('posts the message to sendMessage with the configured chat id', async () => {
    const fetchMock = stubFetch(true);
    const notifier = new TelegramNotifier(true);

    const result = await notifier.send('hello');
    expect(result.ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendMessage');
    const payload = JSON.parse(String(init.body));
    expect(payload.text).toBe('hello');
    expect(payload.chat_id).toBe(process.env.TELEGRAM_CHAT_ID);
  });

  it('skips cleanly when disabled in config', async () => {
    const fetchMock = stubFetch(true);
    const result = await new TelegramNotifier(false).send('hello');
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports API failures without leaking the token', async () => {
    stubFetch(false, { description: 'Unauthorized for bot 123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY-XXXXXX' });
    const result = await new TelegramNotifier(true).send('hello');
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('TEST-TOKEN-FOR-UNIT-TESTS');
    expect(result.error).toContain('[redacted-token]');
  });

  it('surfaces network errors instead of throwing', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
    }) as unknown as typeof fetch;
    const result = await new TelegramNotifier(true).send('hello');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
  });
});

describe('NotificationManager', () => {
  it('formats the appointment alert with Lagos identity, date and time', async () => {
    const fetchMock = stubFetch(true);
    const manager = new NotificationManager({ telegram: true, desktop: false, sound: false });

    const result = buildResult({
      visaType: 'Tourist',
      status: AvailabilityStatus.AVAILABLE,
      message: 'slots',
      appointments: [
        { date: '2026-10-14', time: '09:30' },
        { date: '2026-10-15', time: '10:00' },
      ],
      checkedAt: new Date('2026-09-18T10:42:18Z'),
    });

    await manager.appointmentFound(result);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const text = JSON.parse(String(init.body)).text as string;
    expect(text).toContain('BLS SPAIN APPOINTMENT AVAILABLE');
    expect(text).toContain('Lagos, Nigeria');
    expect(text).toContain('Tourist');
    expect(text).toContain('14 October 2026');
    expect(text).toContain('09:30');
    expect(text).toContain('Complete the booking manually');
    expect(text).toContain('+1 more slot');
  });

  it('formats the login alert', async () => {
    const fetchMock = stubFetch(true);
    const manager = new NotificationManager({ telegram: true, desktop: false, sound: false });

    await manager.manualActionRequired(
      buildResult({
        visaType: 'Tourist',
        status: AvailabilityStatus.LOGIN_REQUIRED,
        message: 'BLS Spain Lagos requires login.',
      }),
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const text = JSON.parse(String(init.body)).text as string;
    expect(text).toContain('requires login');
    expect(text).toContain('Monitoring is paused');
  });

  it('reports channel status', () => {
    const manager = new NotificationManager({ telegram: false, desktop: true, sound: false });
    expect(manager.status()).toEqual({
      telegram: 'disabled',
      desktop: 'enabled',
      sound: 'disabled',
    });
  });
});
