import fs from 'node:fs';
import path from 'node:path';
import { ensureDataDirs, paths } from '../config/config';
import { childLogger } from '../logging/logger';
import type { MonitorState } from '../monitoring/MonitorState';

const log = childLogger('state-store');

/**
 * Persists monitor state to data/state/monitor-state.json.
 *
 * Only operational data lives here. Authentication material stays inside
 * Playwright's own profile directory and is never copied into this file.
 */
export class StateStore {
  constructor(private readonly file: string = paths.stateFile) {}

  load(): Partial<MonitorState> | null {
    try {
      if (!fs.existsSync(this.file)) return null;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<MonitorState>;
      return parsed;
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not read state file, starting fresh');
      return null;
    }
  }

  save(state: MonitorState): void {
    try {
      ensureDataDirs();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not persist state');
    }
  }

  clear(): void {
    if (fs.existsSync(this.file)) fs.rmSync(this.file);
  }

  get filePath(): string {
    return path.resolve(this.file);
  }
}
