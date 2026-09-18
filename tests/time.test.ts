import { describe, expect, it } from 'vitest';
import {
  fileTimestamp,
  formatDateLong,
  formatDuration,
  normalizeDate,
  normalizeTime,
} from '../src/utils/time';

describe('normalizeDate', () => {
  it('normalises ISO dates', () => {
    expect(normalizeDate('2026-10-14')).toBe('2026-10-14');
    expect(normalizeDate('2026/10/14')).toBe('2026-10-14');
  });

  it('normalises day-first textual dates', () => {
    expect(normalizeDate('14 October 2026')).toBe('2026-10-14');
    expect(normalizeDate('14-Oct-2026')).toBe('2026-10-14');
    expect(normalizeDate('1 Sep 26')).toBe('2026-09-01');
  });

  it('normalises month-first textual dates', () => {
    expect(normalizeDate('October 14, 2026')).toBe('2026-10-14');
    expect(normalizeDate('Oct 4 2026')).toBe('2026-10-04');
  });

  it('treats slashed numeric dates as day-first (en-GB, as BLS Nigeria renders)', () => {
    expect(normalizeDate('14/10/2026')).toBe('2026-10-14');
    expect(normalizeDate('01/12/2026')).toBe('2026-12-01');
  });

  it('returns null rather than guessing', () => {
    expect(normalizeDate('')).toBeNull();
    expect(normalizeDate(null)).toBeNull();
    expect(normalizeDate('next week')).toBeNull();
    expect(normalizeDate('31/02/2026')).toBeNull();
    expect(normalizeDate('2026-13-01')).toBeNull();
  });
});

describe('normalizeTime', () => {
  it('normalises 24h times', () => {
    expect(normalizeTime('09:30')).toBe('09:30');
    expect(normalizeTime('9:30')).toBe('09:30');
    expect(normalizeTime('14:05:00')).toBe('14:05');
    expect(normalizeTime('09.30')).toBe('09:30');
  });

  it('normalises 12h times', () => {
    expect(normalizeTime('9:30 AM')).toBe('09:30');
    expect(normalizeTime('2:15 pm')).toBe('14:15');
    expect(normalizeTime('12:00 AM')).toBe('00:00');
    expect(normalizeTime('12:30 PM')).toBe('12:30');
    expect(normalizeTime('9 am')).toBe('09:00');
  });

  it('normalises compact military times', () => {
    expect(normalizeTime('0930 hrs')).toBe('09:30');
  });

  it('returns null for unreadable input', () => {
    expect(normalizeTime('morning')).toBeNull();
    expect(normalizeTime('')).toBeNull();
    expect(normalizeTime('25:99')).toBeNull();
  });
});

describe('formatting helpers', () => {
  it('formats dates for humans', () => {
    expect(formatDateLong('2026-10-14')).toBe('14 October 2026');
  });

  it('builds filesystem-safe timestamps', () => {
    const stamp = fileTimestamp(new Date(2026, 9, 14, 9, 5, 3));
    expect(stamp).toBe('2026-10-14_09-05-03');
  });

  it('formats durations', () => {
    expect(formatDuration(192_000)).toBe('3m 12s');
    expect(formatDuration(45_000)).toBe('45s');
  });
});
