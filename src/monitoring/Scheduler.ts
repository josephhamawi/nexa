import { randomDelayMs } from '../utils/randomDelay';

export type BackoffTier = 'normal' | 'elevated' | 'high';

export interface SchedulerOptions {
  minSeconds: number;
  maxSeconds: number;
}

/**
 * Multipliers applied to the configured interval as errors accumulate.
 * With the default 180-360s base this yields:
 *   normal    3-6 minutes
 *   elevated  5-10 minutes   (1 or 2 consecutive errors)
 *   high      10-20 minutes  (3 or more consecutive errors)
 */
const TIER_MULTIPLIERS: Record<BackoffTier, number> = {
  normal: 1,
  elevated: 5 / 3,
  high: 10 / 3,
};

export function tierForErrors(consecutiveErrors: number): BackoffTier {
  if (consecutiveErrors <= 0) return 'normal';
  if (consecutiveErrors < 3) return 'elevated';
  return 'high';
}

/** Pure delay computation, so the backoff policy is unit-testable. */
export function computeIntervalRange(
  options: SchedulerOptions,
  consecutiveErrors: number,
): { minSeconds: number; maxSeconds: number; tier: BackoffTier } {
  const tier = tierForErrors(consecutiveErrors);
  const factor = TIER_MULTIPLIERS[tier];
  return {
    minSeconds: Math.round(options.minSeconds * factor),
    maxSeconds: Math.round(options.maxSeconds * factor),
    tier,
  };
}

/**
 * Owns the single polling timer.
 *
 * There is exactly one timer per scheduler and one scheduler per monitor, so
 * concurrent polling loops cannot occur. Every delay is randomised inside the
 * current tier's range.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveErrors = 0;
  private nextRunAt: number | null = null;

  constructor(private options: SchedulerOptions) {}

  updateOptions(options: SchedulerOptions): void {
    this.options = options;
  }

  recordSuccess(): void {
    this.consecutiveErrors = 0;
  }

  recordError(): void {
    this.consecutiveErrors += 1;
  }

  get errors(): number {
    return this.consecutiveErrors;
  }

  get tier(): BackoffTier {
    return tierForErrors(this.consecutiveErrors);
  }

  /** Randomised delay for the next poll, in milliseconds. */
  nextDelayMs(): number {
    const range = computeIntervalRange(this.options, this.consecutiveErrors);
    return randomDelayMs(range.minSeconds, range.maxSeconds);
  }

  /** Replaces any pending timer, never stacks a second loop. */
  schedule(run: () => void, delayMs = this.nextDelayMs()): number {
    this.cancel();
    this.nextRunAt = Date.now() + delayMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextRunAt = null;
      run();
    }, delayMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return delayMs;
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRunAt = null;
  }

  get scheduled(): boolean {
    return this.timer !== null;
  }

  /** Epoch ms of the next poll, or null when nothing is scheduled. */
  get nextRunTimestamp(): number | null {
    return this.nextRunAt;
  }
}
