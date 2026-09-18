import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../config/config';
import { childLogger } from '../logging/logger';

const log = childLogger('session');

export type SessionStatus = 'AUTHENTICATED' | 'LOGIN_REQUIRED' | 'UNKNOWN';

export interface SessionInfo {
  profilePath: string;
  exists: boolean;
  fileCount: number;
  lastModified: string | null;
  status: SessionStatus;
  checkedAt: string | null;
}

/**
 * Tracks the state of the persistent Playwright profile.
 *
 * It never reads cookies, tokens or any credential material out of the
 * profile, only directory metadata, and it never writes credentials anywhere.
 * Authentication status is set by the adapter after it observes a real page.
 */
export class SessionManager {
  private status: SessionStatus = 'UNKNOWN';
  private checkedAt: Date | null = null;

  setStatus(status: SessionStatus): void {
    if (status !== this.status) {
      log.info({ from: this.status, to: status }, 'session status changed');
    }
    this.status = status;
    this.checkedAt = new Date();
  }

  getStatus(): SessionStatus {
    return this.status;
  }

  info(): SessionInfo {
    const exists = fs.existsSync(paths.session);
    let fileCount = 0;
    let lastModified: string | null = null;

    if (exists) {
      const entries = fs.readdirSync(paths.session);
      fileCount = entries.length;
      let newest = 0;
      for (const entry of entries) {
        try {
          const stat = fs.statSync(path.join(paths.session, entry));
          newest = Math.max(newest, stat.mtimeMs);
        } catch {
          // Chromium rewrites profile files constantly; a vanished entry is fine.
        }
      }
      lastModified = newest ? new Date(newest).toISOString() : null;
    }

    return {
      profilePath: paths.session,
      exists: exists && fileCount > 0,
      fileCount,
      lastModified,
      status: this.status,
      checkedAt: this.checkedAt ? this.checkedAt.toISOString() : null,
    };
  }

  /** Used only by an explicit user action; the monitor never calls this. */
  clearProfile(): void {
    if (!fs.existsSync(paths.session)) return;
    fs.rmSync(paths.session, { recursive: true, force: true });
    fs.mkdirSync(paths.session, { recursive: true });
    this.status = 'UNKNOWN';
    log.warn('persistent browser profile cleared, a manual login is required');
  }
}
