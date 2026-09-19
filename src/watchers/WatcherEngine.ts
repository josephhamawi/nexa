import { EventEmitter } from 'node:events';
import {
  WatcherStatus,
  captureState,
  createWatcher,
  detectChange,
  type CreateWatcherInput,
  type Watcher,
} from './Watcher';
import { JsonStore } from '../storage/JsonStore';
import { paths } from '../config/config';
import type { BrowserManager } from '../browser/BrowserManager';
import type { BrowserProfile } from '../config/schema';
import type { NotificationManager } from '../notifications/NotificationManager';
import type { ActivityLog } from '../agent/ActivityLog';
import { capture, detectBlocking, redactQuery } from '../browser/ChallengeDetector';
import { readPage } from '../tools/WebResearchTool';
import { shortTarget } from '../tools/WatcherTool';
import { childLogger } from '../logging/logger';

const log = childLogger('watchers');

export interface WatcherEngineOptions {
  minIntervalSeconds: number;
  demoMode: () => boolean;
  resolveProfile: (id: string) => BrowserProfile;
}

/**
 * Checks watchers on their own schedules and reports real changes.
 *
 * Two deliberate choices. A plain HTTP fetch is tried first, because most
 * pages do not need a browser and a fetch costs the target far less. And a
 * failed check is never reported as "no change": errors back off and are
 * surfaced, so silence always means "checked, nothing moved".
 */
export class WatcherEngine extends EventEmitter {
  private readonly store: JsonStore<Watcher>;
  private checking = false;

  constructor(
    private readonly browser: BrowserManager,
    private readonly notifications: NotificationManager,
    private readonly activity: ActivityLog,
    private options: WatcherEngineOptions,
  ) {
    super();
    this.store = new JsonStore<Watcher>(paths.watchersFile);
  }

  updateOptions(options: Partial<WatcherEngineOptions>): void {
    this.options = { ...this.options, ...options };
  }

  all(): Watcher[] {
    return this.store.all();
  }

  get(id: string): Watcher | undefined {
    return this.store.find(id);
  }

  active(): Watcher[] {
    return this.store.filter((watcher) => watcher.status === WatcherStatus.ACTIVE);
  }

  create(input: CreateWatcherInput): Watcher {
    const watcher = createWatcher({
      ...input,
      intervalSeconds: Math.max(this.options.minIntervalSeconds, input.intervalSeconds),
    });
    this.store.insert(watcher);
    this.activity.add(`Watcher created: ${watcher.name}`, 'success');
    this.emit('watcher', watcher);
    return watcher;
  }

  setStatus(id: string, status: 'ACTIVE' | 'PAUSED'): Watcher | undefined {
    const updated = this.store.update(id, (watcher) => ({
      ...watcher,
      status: status === 'ACTIVE' ? WatcherStatus.ACTIVE : WatcherStatus.PAUSED,
      nextCheck: status === 'ACTIVE' ? new Date().toISOString() : null,
    }));
    if (updated) {
      this.activity.add(`Watcher ${status.toLowerCase()}: ${updated.name}`, 'info');
      this.emit('watcher', updated);
    }
    return updated;
  }

  remove(id: string): boolean {
    const watcher = this.get(id);
    const removed = this.store.remove(id);
    if (removed && watcher) {
      this.activity.add(`Watcher deleted: ${watcher.name}`, 'warn');
      this.emit('removed', watcher);
    }
    return removed;
  }

  /** Loose match on name, target or id, for "pause the pricing watcher". */
  findByDescription(text: string): Watcher | undefined {
    const needle = text.trim().toLowerCase();
    if (!needle) return undefined;
    const all = this.store.all();
    return (
      all.find((watcher) => watcher.id === needle) ??
      all.find((watcher) => watcher.name.toLowerCase() === needle) ??
      all.find((watcher) => watcher.name.toLowerCase().includes(needle)) ??
      all.find((watcher) => watcher.target.toLowerCase().includes(needle))
    );
  }

  due(now = new Date()): Watcher[] {
    return this.store.filter(
      (watcher) =>
        watcher.status === WatcherStatus.ACTIVE &&
        (!watcher.nextCheck || new Date(watcher.nextCheck).getTime() <= now.getTime()),
    );
  }

  get isBusy(): boolean {
    return this.checking;
  }

  /** Checks one watcher. Never throws: failures are recorded on the watcher. */
  async check(id: string): Promise<Watcher | undefined> {
    const watcher = this.get(id);
    if (!watcher) return undefined;
    if (this.checking) return watcher;

    this.checking = true;
    try {
      this.activity.add(`Checking ${watcher.name}`, 'info');
      const reading = await this.read(watcher);

      if (!reading.ok) {
        return this.recordFailure(watcher, reading.error, reading.needsHuman);
      }

      const current = captureState(reading.content);
      const change = detectChange(watcher.currentState, current, watcher.keywords);
      const now = new Date().toISOString();

      const updated = this.store.update(watcher.id, (existing) => ({
        ...existing,
        status: WatcherStatus.ACTIVE,
        lastChecked: now,
        nextCheck: new Date(Date.now() + existing.intervalSeconds * 1000).toISOString(),
        previousState: change.changed ? existing.currentState : existing.previousState,
        currentState: current,
        lastChanged: change.changed ? now : existing.lastChanged,
        changeSummary: change.changed ? change.summary : existing.changeSummary,
        consecutiveErrors: 0,
        lastError: null,
      }));

      if (!updated) return undefined;
      this.emit('watcher', updated);

      if (change.changed && change.summary) {
        this.activity.add(`Change detected: ${updated.name}`, 'success');
        if (updated.notifyOnChange) {
          await this.notifications.watcherChanged({
            watcherName: updated.name,
            target: updated.target,
            summary: change.summary,
            chatId: updated.sourceChatId ?? null,
          });
        }
        this.emit('changed', updated, change);
      } else if (!watcher.currentState) {
        // First reading is the baseline, not a change.
        this.activity.add(`Baseline captured for ${updated.name}`, 'info');
      }

      return updated;
    } finally {
      this.checking = false;
    }
  }

  private async read(
    watcher: Watcher,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string; needsHuman?: boolean }> {
    if (this.options.demoMode()) {
      return { ok: true, content: `Demo mode reading for ${watcher.target} at ${new Date().toISOString()}` };
    }

    // Plain fetch first: cheaper for them, faster for us.
    if (!watcher.selector) {
      const text = await readPage(watcher.target, 40_000);
      if (text) return { ok: true, content: text };
    }

    // Fall back to a real browser for client-rendered pages or a selector.
    try {
      const profile = this.options.resolveProfile(watcher.browserProfileId);
      return await this.browser.runOwned(async () => {
        const page = await this.browser.getPage(profile);
        const response = await page.goto(watcher.target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

        const snapshot = await capture(page, response?.status() ?? null);
        const blocking = detectBlocking(snapshot);
        if (blocking.detected) {
          return {
            ok: false as const,
            error: `${blocking.kind}: ${blocking.reason}`,
            needsHuman: blocking.kind === 'CAPTCHA' || blocking.kind === 'LOGIN' || blocking.kind === 'MFA',
          };
        }

        if (watcher.selector) {
          const text = await page
            .locator(watcher.selector)
            .first()
            .innerText({ timeout: 10_000 })
            .catch(() => '');
          if (!text) {
            return { ok: false as const, error: `selector "${watcher.selector}" matched nothing` };
          }
          return { ok: true as const, content: text };
        }

        return { ok: true as const, content: snapshot.visibleText };
      });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  private async recordFailure(watcher: Watcher, error: string, needsHuman = false): Promise<Watcher | undefined> {
    const errors = watcher.consecutiveErrors + 1;
    // Back off hard on repeated failures so a dead target is not hammered.
    const backoff = Math.min(8, 2 ** Math.min(errors, 3));

    const updated = this.store.update(watcher.id, (existing) => ({
      ...existing,
      status: needsHuman ? WatcherStatus.WAITING_FOR_HUMAN : errors >= 3 ? WatcherStatus.ERROR : existing.status,
      lastChecked: new Date().toISOString(),
      nextCheck: new Date(Date.now() + existing.intervalSeconds * backoff * 1000).toISOString(),
      consecutiveErrors: errors,
      lastError: error,
    }));

    if (!updated) return undefined;

    log.warn({ watcher: updated.id, target: redactQuery(updated.target), err: error }, 'watcher check failed');
    this.activity.add(`${updated.name}: ${error}`, errors >= 3 ? 'error' : 'warn');

    if (needsHuman) {
      await this.notifications.humanNeeded({
        taskName: updated.name,
        reason: `${shortTarget(updated.target)} is asking for a human: ${error}`,
        taskId: updated.id,
        chatId: updated.sourceChatId ?? null,
      });
    } else if (errors === 3) {
      await this.notifications.taskFailed({
        taskName: updated.name,
        error: `Three failed checks in a row: ${error}`,
        chatId: updated.sourceChatId ?? null,
      });
    }

    this.emit('watcher', updated);
    return updated;
  }

  /** Clears scheduling state that a restart invalidated. */
  recoverOnStartup(): number {
    let restored = 0;
    for (const watcher of this.store.all()) {
      if (watcher.status !== WatcherStatus.ACTIVE) continue;
      if (!watcher.nextCheck || new Date(watcher.nextCheck).getTime() < Date.now()) {
        this.store.update(watcher.id, (existing) => ({
          ...existing,
          // Stagger so several watchers do not all fire the instant Nexa opens.
          nextCheck: new Date(Date.now() + 10_000 + restored * 5000).toISOString(),
        }));
        restored += 1;
      }
    }
    return restored;
  }
}
