import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDirs } from '../config/config';
import { childLogger } from '../logging/logger';

const log = childLogger('store');

/**
 * A small durable collection of records, kept as one JSON file.
 *
 * Writes go to a temp file and are renamed into place, so a crash mid-write
 * cannot leave a half-written file that loses every task you had scheduled.
 * Nexa's volumes are tiny (hundreds of records), so a database would be more
 * ceremony than value.
 */
export class JsonStore<T extends { id: string }> {
  private items: T[] = [];
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly onChange?: () => void,
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.file)) return;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as T[];
      if (Array.isArray(parsed)) this.items = parsed;
    } catch (err) {
      log.warn({ file: path.basename(this.file), err: (err as Error).message }, 'could not read store');
      this.items = [];
    }
  }

  private persist(): void {
    try {
      ensureDataDirs();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.items, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
      this.onChange?.();
    } catch (err) {
      log.warn({ file: path.basename(this.file), err: (err as Error).message }, 'could not persist store');
    }
  }

  all(): T[] {
    this.load();
    return [...this.items];
  }

  find(id: string): T | undefined {
    this.load();
    return this.items.find((item) => item.id === id);
  }

  filter(predicate: (item: T) => boolean): T[] {
    this.load();
    return this.items.filter(predicate);
  }

  insert(item: T): T {
    this.load();
    this.items.push(item);
    this.persist();
    return item;
  }

  update(id: string, mutate: (item: T) => T): T | undefined {
    this.load();
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return undefined;
    const next = mutate(this.items[index] as T);
    this.items[index] = next;
    this.persist();
    return next;
  }

  upsert(item: T): T {
    this.load();
    const index = this.items.findIndex((existing) => existing.id === item.id);
    if (index === -1) this.items.push(item);
    else this.items[index] = item;
    this.persist();
    return item;
  }

  remove(id: string): boolean {
    this.load();
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (this.items.length === before) return false;
    this.persist();
    return true;
  }

  /** Keeps the newest `keep` records, oldest first by the given field. */
  prune(keep: number, sortBy: (item: T) => string): void {
    this.load();
    if (this.items.length <= keep) return;
    this.items = [...this.items]
      .sort((a, b) => sortBy(a).localeCompare(sortBy(b)))
      .slice(this.items.length - keep);
    this.persist();
  }

  get size(): number {
    this.load();
    return this.items.length;
  }
}
