import { describe, expect, it } from 'vitest';
import {
  AvailabilityStatus,
  describeStatus,
  haltsMonitoring,
  isAppointmentFoundTransition,
  isErrorStatus,
  requiresManualAction,
} from '../src/availability/AvailabilityState';
import { createInitialState, restoreState, rollDailyStats, localDay } from '../src/monitoring/MonitorState';

describe('state transitions', () => {
  it('fires APPOINTMENT_FOUND only when entering AVAILABLE', () => {
    expect(
      isAppointmentFoundTransition(AvailabilityStatus.NOT_AVAILABLE, AvailabilityStatus.AVAILABLE),
    ).toBe(true);
    expect(isAppointmentFoundTransition(null, AvailabilityStatus.AVAILABLE)).toBe(true);
    expect(
      isAppointmentFoundTransition(AvailabilityStatus.ERROR, AvailabilityStatus.AVAILABLE),
    ).toBe(true);
  });

  it('does not re-fire while the slot stays available', () => {
    expect(
      isAppointmentFoundTransition(AvailabilityStatus.AVAILABLE, AvailabilityStatus.AVAILABLE),
    ).toBe(false);
  });

  it('never fires for a non-AVAILABLE status', () => {
    for (const status of [
      AvailabilityStatus.NOT_AVAILABLE,
      AvailabilityStatus.ERROR,
      AvailabilityStatus.CAPTCHA_REQUIRED,
      AvailabilityStatus.SITE_UNAVAILABLE,
    ]) {
      expect(isAppointmentFoundTransition(AvailabilityStatus.NOT_AVAILABLE, status)).toBe(false);
    }
  });

  it('classifies statuses', () => {
    expect(requiresManualAction(AvailabilityStatus.CAPTCHA_REQUIRED)).toBe(true);
    expect(requiresManualAction(AvailabilityStatus.NOT_AVAILABLE)).toBe(false);
    expect(isErrorStatus(AvailabilityStatus.ERROR)).toBe(true);
    expect(isErrorStatus(AvailabilityStatus.SITE_UNAVAILABLE)).toBe(true);
    expect(isErrorStatus(AvailabilityStatus.NOT_AVAILABLE)).toBe(false);
    expect(haltsMonitoring(AvailabilityStatus.AVAILABLE)).toBe(true);
    expect(haltsMonitoring(AvailabilityStatus.NOT_AVAILABLE)).toBe(false);
    expect(describeStatus(AvailabilityStatus.NOT_AVAILABLE)).toBe('No appointments available');
  });
});

describe('daily statistics', () => {
  it('keeps counters within the same day', () => {
    const stats = { day: localDay(), checksToday: 5, appointmentsFound: 1, errorsToday: 2 };
    expect(rollDailyStats(stats)).toBe(stats);
  });

  it('resets counters on a new day', () => {
    const stats = { day: '2020-01-01', checksToday: 5, appointmentsFound: 1, errorsToday: 2 };
    const rolled = rollDailyStats(stats);
    expect(rolled.checksToday).toBe(0);
    expect(rolled.appointmentsFound).toBe(0);
    expect(rolled.errorsToday).toBe(0);
    expect(rolled.day).toBe(localDay());
  });
});

describe('restoreState', () => {
  it('never comes back up as RUNNING', () => {
    const restored = restoreState({ ...createInitialState(), runState: 'RUNNING' });
    expect(restored.runState).toBe('IDLE');
    expect(restored.nextCheck).toBeNull();
  });

  it('falls back to a clean state when nothing is persisted', () => {
    const restored = restoreState(null);
    expect(restored.runState).toBe('IDLE');
    expect(restored.stats.checksToday).toBe(0);
  });

  it('keeps a manual-action status across a restart', () => {
    const restored = restoreState({
      ...createInitialState(),
      currentStatus: AvailabilityStatus.CAPTCHA_REQUIRED,
    });
    expect(restored.currentStatus).toBe(AvailabilityStatus.CAPTCHA_REQUIRED);
  });
});
