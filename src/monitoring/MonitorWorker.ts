import type { BlsSpainAdapter } from '../bls/BlsSpainAdapter';
import type { AvailabilityResult } from '../availability/AvailabilityResult';
import { childLogger } from '../logging/logger';

const log = childLogger('monitor-worker');

/**
 * Runs a single availability check at a time.
 *
 * The `inFlight` guard is what guarantees the "only one BLS monitoring worker"
 * rule: a scheduled poll arriving while a manual CHECK NOW is still running is
 * skipped rather than queued, so the site never sees two concurrent sessions.
 */
export class MonitorWorker {
  private inFlight: Promise<AvailabilityResult> | null = null;
  private controller: AbortController | null = null;

  constructor(private readonly adapter: BlsSpainAdapter) {}

  get isRunning(): boolean {
    return this.inFlight !== null;
  }

  /** Returns null when a check is already in progress. */
  async runOnce(): Promise<AvailabilityResult | null> {
    if (this.inFlight) {
      log.debug('check skipped; another check is still running');
      return null;
    }

    this.controller = new AbortController();
    const signal = this.controller.signal;

    this.inFlight = this.adapter.check(signal);

    try {
      const result = await this.inFlight;
      log.info(
        { status: result.status, slots: result.appointments.length },
        'check complete',
      );
      return result;
    } finally {
      this.inFlight = null;
      this.controller = null;
    }
  }

  /** Signals an in-flight check to give up (used on pause / shutdown). */
  abort(): void {
    this.controller?.abort();
  }
}
