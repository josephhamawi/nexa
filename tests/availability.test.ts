import { describe, expect, it } from 'vitest';
import {
  buildResult,
  dedupeSlots,
  filterSlots,
  normalizeSlots,
} from '../src/availability/AvailabilityResult';
import { AvailabilityStatus, requiresManualAction } from '../src/availability/AvailabilityState';

describe('normalizeSlots', () => {
  it('normalises and sorts slots, reporting what it could not read', () => {
    const { slots, unparsed } = normalizeSlots([
      { date: '21/11/2026', time: '2:00 PM' },
      { date: '14 October 2026', time: '09:30' },
      { date: 'sometime soon', time: '09:30' },
      { date: '2026-10-14', time: 'morning' },
    ]);

    expect(slots).toEqual([
      { date: '2026-10-14', time: '09:30' },
      { date: '2026-11-21', time: '14:00' },
    ]);
    expect(unparsed).toHaveLength(2);
  });

  it('keeps slots that have a date but no time', () => {
    const { slots } = normalizeSlots([{ date: '2026-10-14' }]);
    expect(slots).toEqual([{ date: '2026-10-14', time: null }]);
  });

  it('deduplicates identical slots', () => {
    const slots = dedupeSlots([
      { date: '2026-10-14', time: '09:30' },
      { date: '2026-10-14', time: '09:30' },
    ]);
    expect(slots).toHaveLength(1);
  });
});

describe('date filtering', () => {
  const slots = [
    { date: '2026-09-20', time: '09:30' },
    { date: '2026-10-14', time: '09:30' },
    { date: '2026-12-31', time: '09:30' },
    { date: '2027-01-05', time: '09:30' },
  ];

  it('accepts everything when no range is configured', () => {
    expect(filterSlots(slots, {})).toHaveLength(4);
    expect(filterSlots(slots, { preferredDateFrom: '', preferredDateTo: '' })).toHaveLength(4);
  });

  it('applies an inclusive range', () => {
    const filtered = filterSlots(slots, {
      preferredDateFrom: '2026-10-01',
      preferredDateTo: '2026-12-31',
    });
    expect(filtered.map((s) => s.date)).toEqual(['2026-10-14', '2026-12-31']);
  });

  it('applies an open-ended lower bound', () => {
    const filtered = filterSlots(slots, { preferredDateFrom: '2026-12-01' });
    expect(filtered.map((s) => s.date)).toEqual(['2026-12-31', '2027-01-05']);
  });
});

describe('time filtering', () => {
  const slots = [
    { date: '2026-10-14', time: '08:00' },
    { date: '2026-10-14', time: '09:30' },
    { date: '2026-10-14', time: '13:00' },
    { date: '2026-10-14', time: '16:45' },
    { date: '2026-10-14', time: null },
  ];

  it('accepts everything when no range is configured', () => {
    expect(filterSlots(slots, {})).toHaveLength(5);
  });

  it('applies an inclusive window', () => {
    const filtered = filterSlots(slots, {
      preferredTimeFrom: '09:00',
      preferredTimeTo: '13:00',
    });
    expect(filtered.map((s) => s.time)).toEqual(['09:30', '13:00', null]);
  });

  it('keeps slots with an unknown time rather than hiding a real appointment', () => {
    const filtered = filterSlots(slots, { preferredTimeFrom: '17:00' });
    expect(filtered).toEqual([{ date: '2026-10-14', time: null }]);
  });
});

describe('buildResult', () => {
  it('always carries the Lagos-only identity', () => {
    const result = buildResult({
      visaType: 'Tourist',
      status: AvailabilityStatus.NOT_AVAILABLE,
      message: 'No appointments available',
    });

    expect(result.provider).toBe('BLS');
    expect(result.country).toBe('Spain');
    expect(result.city).toBe('Lagos');
    expect(result.centre).toBe('Lagos');
    expect(result.available).toBe(false);
    expect(result.appointments).toEqual([]);
    expect(result.requiresManualAction).toBe(false);
    expect(Date.parse(result.checkedAt)).not.toBeNaN();
  });

  it('cannot report available without slots', () => {
    const result = buildResult({
      visaType: 'Tourist',
      status: AvailabilityStatus.AVAILABLE,
      message: 'slots',
      appointments: [],
    });
    expect(result.available).toBe(false);
  });

  it('drops slots that arrive with a non-AVAILABLE status', () => {
    const result = buildResult({
      visaType: 'Tourist',
      status: AvailabilityStatus.ERROR,
      message: 'boom',
      appointments: [{ date: '2026-10-14', time: '09:30' }],
    });
    expect(result.appointments).toEqual([]);
    expect(result.available).toBe(false);
  });

  it('flags manual-action statuses', () => {
    for (const status of [
      AvailabilityStatus.CAPTCHA_REQUIRED,
      AvailabilityStatus.LOGIN_REQUIRED,
      AvailabilityStatus.SESSION_EXPIRED,
      AvailabilityStatus.HUMAN_VERIFICATION_REQUIRED,
    ]) {
      expect(requiresManualAction(status)).toBe(true);
      expect(
        buildResult({ visaType: 'Tourist', status, message: 'x' }).requiresManualAction,
      ).toBe(true);
    }
  });
});
