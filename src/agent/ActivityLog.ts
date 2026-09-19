import fs from 'node:fs';
import { ensureDataDirs, paths } from '../config/config';
import { formatClock } from '../utils/time';

export type ActivityLevel = 'info' | 'success' | 'warn' | 'error';

export interface ActivityEntry {
  id: string;
  at: string;
  /** Local HH:mm:ss, pre-formatted for the dashboard. */
  clock: string;
  level: ActivityLevel;
  message: string;
  taskId?: string | null;
}

const MAX_IN_MEMORY = 400;

/**
 * The agent's visible timeline.
 *
 * This is what makes Nexa legible: instead of a spinner, you see the sequence
 * of things it actually did. Operational lines only, never internal reasoning.
 */
export class ActivityLog {
  private entries: ActivityEntry[] = [];
  private counter = 0;
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();

  constructor(private readonly file: string = paths.activityFile) {
    this.restore();
  }

  add(message: string, level: ActivityLevel = 'info', taskId?: string | null): ActivityEntry {
    const now = new Date();
    this.counter += 1;
    const entry: ActivityEntry = {
      id: `${now.getTime()}-${this.counter}`,
      at: now.toISOString(),
      clock: formatClock(now),
      level,
      message: message.slice(0, 400),
      taskId: taskId ?? null,
    };

    this.entries.push(entry);
    if (this.entries.length > MAX_IN_MEMORY) {
      this.entries.splice(0, this.entries.length - MAX_IN_MEMORY);
    }

    this.append(entry);
    for (const listener of this.listeners) listener(entry);
    return entry;
  }

  /** Most recent first. */
  recent(limit = 150): ActivityEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  forTask(taskId: string): ActivityEntry[] {
    return this.entries.filter((entry) => entry.taskId === taskId);
  }

  onEntry(listener: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private append(entry: ActivityEntry): void {
    try {
      ensureDataDirs();
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      // The timeline is a convenience; a disk failure must not stop the agent.
    }
  }

  private restore(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-MAX_IN_MEMORY);
      for (const line of lines) {
        if (!line.trim()) continue;
        this.entries.push(JSON.parse(line) as ActivityEntry);
      }
    } catch {
      this.entries = [];
    }
  }
}
