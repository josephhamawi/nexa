import { afterEach, describe, expect, it, vi } from 'vitest';
import { Scheduler, computeIntervalRange, tierForErrors } from '../src/monitoring/Scheduler';
import { randomDelayMs, randomIntBetween } from '../src/utils/randomDelay';

const BASE = { minSeconds: 180, maxSeconds: 360 };

afterEach(() => {
  vi.useRealTimers();
});

describe('backoff tiers', () => {
  it('maps consecutive errors to tiers', () => {
    expect(tierForErrors(0)).toBe('normal');
    expect(tierForErrors(1)).toBe('elevated');
    expect(tierForErrors(2)).toBe('elevated');
    expect(tierForErrors(3)).toBe('high');
    expect(tierForErrors(9)).toBe('high');
  });

  it('produces the documented ranges for the default interval', () => {
    expect(computeIntervalRange(BASE, 0)).toEqual({ minSeconds: 180, maxSeconds: 360, tier: 'normal' });
    expect(computeIntervalRange(BASE, 1)).toEqual({ minSeconds: 300, maxSeconds: 600, tier: 'elevated' });
    expect(computeIntervalRange(BASE, 4)).toEqual({ minSeconds: 600, maxSeconds: 1200, tier: 'high' });
  });
});

describe('randomised delays', () => {
  it('stays inside the configured range', () => {
    for (let i = 0; i < 300; i += 1) {
      const ms = randomDelayMs(180, 360);
      expect(ms).toBeGreaterThanOrEqual(180_000);
      expect(ms).toBeLessThanOrEqual(360_000);
    }
  });

  it('actually varies rather than returning a constant', () => {
    const values = new Set(Array.from({ length: 80 }, () => randomIntBetween(180, 360)));
    expect(values.size).toBeGreaterThan(10);
  });

  it('rejects an inverted range', () => {
    expect(() => randomIntBetween(10, 1)).toThrow();
  });
});

describe('Scheduler', () => {
  it('escalates and resets with error state', () => {
    const scheduler = new Scheduler(BASE);
    expect(scheduler.tier).toBe('normal');
    scheduler.recordError();
    expect(scheduler.tier).toBe('elevated');
    scheduler.recordError();
    scheduler.recordError();
    expect(scheduler.tier).toBe('high');
    scheduler.recordSuccess();
    expect(scheduler.tier).toBe('normal');
    expect(scheduler.errors).toBe(0);
  });

  it('never stacks two timers, a second schedule replaces the first', () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler(BASE);
    const run = vi.fn();

    scheduler.schedule(run, 1000);
    scheduler.schedule(run, 1000);
    expect(scheduler.scheduled).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending run', () => {
    vi.useFakeTimers();
    const scheduler = new Scheduler(BASE);
    const run = vi.fn();
    scheduler.schedule(run, 1000);
    scheduler.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.scheduled).toBe(false);
    expect(scheduler.nextRunTimestamp).toBeNull();
  });
});
