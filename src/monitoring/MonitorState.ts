import { AvailabilityStatus } from '../availability/AvailabilityState';
import type { AvailabilityResult } from '../availability/AvailabilityResult';
import type { SessionStatus } from '../browser/SessionManager';

export type RunState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'STOPPED';

export interface MonitorStats {
  /** Local calendar day the counters belong to (YYYY-MM-DD). */
  day: string;
  checksToday: number;
  appointmentsFound: number;
  errorsToday: number;
}

export interface MonitorState {
  runState: RunState;
  currentStatus: AvailabilityStatus;
  /** Status of the previous completed check, drives APPOINTMENT_FOUND. */
  previousStatus: AvailabilityStatus | null;
  lastCheck: string | null;
  nextCheck: string | null;
  lastAvailability: AvailabilityResult | null;
  stats: MonitorStats;
  /** Consecutive failures; resets on any successful check. */
  errorCount: number;
  lastError: { message: string; code: string | null; at: string } | null;
  lastNotification: { channel: string; at: string; ok: boolean } | null;
  sessionStatus: SessionStatus;
  /** True when the user must act in the browser before monitoring resumes. */
  manualActionRequired: boolean;
  manualActionReason: string | null;
  /** Epoch ms of the last manual CHECK NOW, for the cooldown. */
  lastManualCheckAt: number | null;
  updatedAt: string;
}

export function localDay(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function createInitialState(): MonitorState {
  return {
    runState: 'IDLE',
    currentStatus: AvailabilityStatus.STOPPED,
    previousStatus: null,
    lastCheck: null,
    nextCheck: null,
    lastAvailability: null,
    stats: { day: localDay(), checksToday: 0, appointmentsFound: 0, errorsToday: 0 },
    errorCount: 0,
    lastError: null,
    lastNotification: null,
    sessionStatus: 'UNKNOWN',
    manualActionRequired: false,
    manualActionReason: null,
    lastManualCheckAt: null,
    updatedAt: new Date().toISOString(),
  };
}

/** Rolls the daily counters over at local midnight. */
export function rollDailyStats(stats: MonitorStats, now: Date = new Date()): MonitorStats {
  const today = localDay(now);
  if (stats.day === today) return stats;
  return { day: today, checksToday: 0, appointmentsFound: 0, errorsToday: 0 };
}

/**
 * Merges persisted state back in after a restart.
 * Run state is never restored as RUNNING: a fresh process starts idle and the
 * user (or the CLI) decides to start monitoring again.
 */
export function restoreState(persisted: Partial<MonitorState> | null): MonitorState {
  const base = createInitialState();
  if (!persisted) return base;
  return {
    ...base,
    ...persisted,
    runState: 'IDLE',
    currentStatus:
      persisted.currentStatus && persisted.currentStatus !== AvailabilityStatus.MONITORING
        ? persisted.currentStatus
        : AvailabilityStatus.STOPPED,
    stats: rollDailyStats(persisted.stats ?? base.stats),
    nextCheck: null,
    updatedAt: new Date().toISOString(),
  };
}
