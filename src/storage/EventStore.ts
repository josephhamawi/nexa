import fs from 'node:fs';
import { ensureDataDirs, paths } from '../config/config';
import { formatClock } from '../utils/time';

export type EventLevel = 'info' | 'success' | 'warn' | 'error';

export interface MonitorEvent {
  id: string;
  /** ISO-8601 UTC. */
  at: string;
  /** Local HH:mm:ss, pre-formatted for the dashboard. */
  clock: string;
  source: string;
  level: EventLevel;
  message: string;
}

const MAX_IN_MEMORY = 300;

/**
 * Append-only event log, kept both in memory (for the dashboard) and on disk
 * as JSON Lines (for post-mortems).
 */
export class EventStore {
  private events: MonitorEvent[] = [];
  private counter = 0;
  private listeners = new Set<(event: MonitorEvent) => void>();

  constructor(private readonly file: string = paths.eventsFile) {
    this.restore();
  }

  add(message: string, level: EventLevel = 'info', source = 'BLS Lagos'): MonitorEvent {
    const now = new Date();
    this.counter += 1;
    const event: MonitorEvent = {
      id: `${now.getTime()}-${this.counter}`,
      at: now.toISOString(),
      clock: formatClock(now),
      source,
      level,
      message,
    };

    this.events.push(event);
    if (this.events.length > MAX_IN_MEMORY) this.events.splice(0, this.events.length - MAX_IN_MEMORY);

    this.append(event);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Most recent first. */
  recent(limit = 100): MonitorEvent[] {
    return this.events.slice(-limit).reverse();
  }

  onEvent(listener: (event: MonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private append(event: MonitorEvent): void {
    try {
      ensureDataDirs();
      fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // The event log is a convenience; a disk failure must not stop monitoring.
    }
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-MAX_IN_MEMORY);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.events.push(JSON.parse(line) as MonitorEvent);
      }
    } catch {
      this.events = [];
    }
  }
}
