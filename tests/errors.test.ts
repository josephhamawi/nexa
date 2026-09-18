import { describe, expect, it } from 'vitest';
import {
  BlsErrorCode,
  LagosSelectionError,
  SiteUnavailableError,
  VisaCategoryNotFoundError,
  WebsiteStructureChangedError,
  toBlsError,
} from '../src/bls/errors';
import { withRetry } from '../src/utils/retry';

describe('BLS error mapping', () => {
  it('keeps structure-change errors distinct and carries evidence', () => {
    const err = new WebsiteStructureChangedError('cannot read the calendar', {
      url: 'https://nigeria.blsspainglobal.com/Global/blsappointment/MyAppointments',
      title: 'Appointment',
      visibleText: 'something unexpected',
    });
    expect(err.code).toBe(BlsErrorCode.WEBSITE_STRUCTURE_CHANGED);
    expect(err.evidence.title).toBe('Appointment');
    expect(toBlsError(err)).toBe(err);
  });

  it('classifies Lagos and visa-category failures', () => {
    expect(new LagosSelectionError('nope').code).toBe(BlsErrorCode.LAGOS_SELECTION_ERROR);
    const visa = new VisaCategoryNotFoundError('nope', ['Business', 'Student']);
    expect(visa.code).toBe(BlsErrorCode.VISA_CATEGORY_NOT_FOUND);
    expect(visa.availableCategories).toEqual(['Business', 'Student']);
  });

  it('treats network failures as site-unavailable, not as an answer', () => {
    const mapped = toBlsError(new Error('net::ERR_CONNECTION_RESET at https://…'));
    expect(mapped).toBeInstanceOf(SiteUnavailableError);
    expect(mapped.code).toBe(BlsErrorCode.SITE_UNAVAILABLE);
    expect(toBlsError(new Error('Timeout 45000ms exceeded')).code).toBe(BlsErrorCode.SITE_UNAVAILABLE);
  });

  it('falls back to UNKNOWN for anything else', () => {
    expect(toBlsError(new Error('something odd')).code).toBe(BlsErrorCode.UNKNOWN);
    expect(toBlsError('a string').code).toBe(BlsErrorCode.UNKNOWN);
  });
});

describe('withRetry', () => {
  it('returns the first successful attempt', async () => {
    let calls = 0;
    const value = await withRetry(async () => {
      calls += 1;
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries transient failures then succeeds', async () => {
    let calls = 0;
    const value = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('flaky');
        return 'ok';
      },
      { attempts: 3, baseDelayMs: 1 },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up immediately when shouldRetry says no', async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('captcha');
        },
        { attempts: 5, baseDelayMs: 1, shouldRetry: () => false },
      ),
    ).rejects.toThrow('captcha');
    expect(calls).toBe(1);
  });

  it('propagates the last error after exhausting attempts', async () => {
    await expect(
      withRetry(
        async () => {
          throw new Error('always down');
        },
        { attempts: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow('always down');
  });
});
