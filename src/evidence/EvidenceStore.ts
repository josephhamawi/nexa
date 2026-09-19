import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { ensureDataDirs, paths } from '../config/config';
import { fileTimestamp } from '../utils/time';
import { childLogger } from '../logging/logger';
import type { Evidence } from '../tasks/Task';

const log = childLogger('evidence');

/**
 * Evidence is what makes Nexa's reports auditable.
 *
 * Every claim a task makes should be traceable to a URL, a timestamp, a
 * screenshot or a captured payload, so "I found 3 roles" can be checked rather
 * than trusted.
 */
export class EvidenceStore {
  private directoryFor(taskId: string): string {
    ensureDataDirs();
    const dir = path.join(paths.evidence, taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Best effort: a failed capture must never break the task it documents. */
  async screenshot(taskId: string, page: Page | null, label: string): Promise<string | null> {
    if (!page || page.isClosed()) return null;
    const file = path.join(this.directoryFor(taskId), `${fileTimestamp()}_${safe(label)}.png`);
    try {
      await page.screenshot({ path: file, fullPage: true });
      log.debug({ taskId, file: path.basename(file) }, 'screenshot captured');
      return file;
    } catch (err) {
      log.warn({ taskId, err: (err as Error).message }, 'screenshot failed');
      return null;
    }
  }

  /** Persists structured output next to the screenshots that produced it. */
  savePayload(taskId: string, label: string, data: unknown): string | null {
    const file = path.join(this.directoryFor(taskId), `${fileTimestamp()}_${safe(label)}.json`);
    try {
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      return file;
    } catch (err) {
      log.warn({ taskId, err: (err as Error).message }, 'could not save payload');
      return null;
    }
  }

  build(taskId: string, stepId: string | null, input: Omit<Evidence, 'id' | 'taskId' | 'at' | 'stepId'>): Evidence {
    return {
      id: randomUUID(),
      taskId,
      stepId,
      at: new Date().toISOString(),
      ...input,
    };
  }

  list(taskId: string): string[] {
    const dir = path.join(paths.evidence, taskId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((file) => path.join(dir, file));
  }

  /** Keeps the evidence directory from growing without bound. */
  pruneOlderThan(days: number): void {
    ensureDataDirs();
    const cutoff = Date.now() - days * 86_400_000;
    for (const entry of fs.readdirSync(paths.evidence)) {
      const dir = path.join(paths.evidence, entry);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // a vanished directory is fine
      }
    }
  }
}

function safe(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40).toLowerCase() || 'evidence';
}
