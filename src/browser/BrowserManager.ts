import fs from 'node:fs';
import path from 'node:path';
import { chromium, firefox, webkit, type BrowserContext, type Page } from 'playwright';
import { ensureDataDirs, profileDirectory } from '../config/config';
import type { BrowserProfile } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('browser');

/**
 * Raised when a second process tries to drive the same persistent profile.
 *
 * Two browsers sharing one profile directory fight over the cookie store and
 * the loser silently loses its logged-in session, which is maddening to debug.
 */
export class ProfileInUseError extends Error {
  constructor(profileId: string, pid: number) {
    super(
      `Browser profile "${profileId}" is already in use by process ${pid}. ` +
        'Close the other Nexa instance or CLI command first.',
    );
    this.name = 'ProfileInUseError';
  }
}

interface ProfileSession {
  context: BrowserContext;
  page: Page | null;
  holdsLock: boolean;
}

/**
 * Owns every persistent browser profile.
 *
 * Deliberately plain automation: stock browsers, stock user agents, no stealth
 * plugins and no fingerprint patching. When a site blocks automation, Nexa asks
 * you to take over rather than trying to look like someone else.
 */
export class BrowserManager {
  private readonly sessions = new Map<string, ProfileSession>();
  private readonly launching = new Map<string, Promise<BrowserContext>>();
  private readonly watchedPages = new WeakSet<Page>();

  /** Depth counter: >0 means the activity happening now is Nexa's, not yours. */
  private ownedOperations = 0;
  private lastUserActivityAt: number | null = null;

  isRunning(profileId = 'default'): boolean {
    return this.sessions.has(profileId);
  }

  activeProfiles(): string[] {
    return [...this.sessions.keys()];
  }

  async launch(profile: BrowserProfile): Promise<BrowserContext> {
    const existing = this.sessions.get(profile.id);
    if (existing) return existing.context;

    const inFlight = this.launching.get(profile.id);
    if (inFlight) return inFlight;

    const promise = (async () => {
      ensureDataDirs();
      const dir = profileDirectory(profile.id);
      fs.mkdirSync(dir, { recursive: true });
      const holdsLock = this.acquireProfileLock(profile.id, dir);

      log.info({ profile: profile.id, engine: profile.engine }, 'launching browser profile');

      const engine = profile.engine === 'firefox' ? firefox : profile.engine === 'webkit' ? webkit : chromium;
      const context = await engine.launchPersistentContext(dir, {
        headless: profile.headless,
        viewport: null,
        acceptDownloads: false,
        args: profile.engine === 'chromium' ? ['--start-maximized'] : undefined,
      });

      // tsx/esbuild rewrites named functions to call a `__name` helper, which
      // does not exist inside the page. Defining it as identity keeps
      // page.evaluate working from the CLI entry points.
      await context.addInitScript(() => {
        const globalObject = globalThis as unknown as Record<string, unknown>;
        if (typeof globalObject.__name !== 'function') {
          globalObject.__name = (value: unknown): unknown => value;
        }
      });

      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(60_000);

      context.on('page', (page) => {
        this.noteUserActivity('new tab opened');
        this.watchPage(page);
      });

      context.on('close', () => {
        log.warn({ profile: profile.id }, 'browser context closed');
        this.releaseProfileLock(profile.id, dir);
        this.sessions.delete(profile.id);
      });

      this.sessions.set(profile.id, { context, page: null, holdsLock });
      return context;
    })();

    this.launching.set(profile.id, promise);
    try {
      return await promise;
    } finally {
      this.launching.delete(profile.id);
    }
  }

  async getPage(profile: BrowserProfile): Promise<Page> {
    const context = await this.launch(profile);
    const session = this.sessions.get(profile.id);
    if (session?.page && !session.page.isClosed()) return session.page;

    const existing = context.pages().find((p) => !p.isClosed());
    const page = existing ?? (await context.newPage());

    // A freshly launched context may still be committing its initial
    // about:blank navigation; navigating on top of that races and fails.
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);

    this.watchPage(page);
    if (session) session.page = page;
    return page;
  }

  currentPage(profileId = 'default'): Page | null {
    const session = this.sessions.get(profileId);
    if (!session?.page || session.page.isClosed()) return null;
    return session.page;
  }

  async bringToFront(profileId = 'default'): Promise<void> {
    const page = this.currentPage(profileId);
    if (!page) return;
    try {
      await page.bringToFront();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'bringToFront failed');
    }
  }

  async close(profileId: string): Promise<void> {
    const session = this.sessions.get(profileId);
    if (!session) return;
    this.sessions.delete(profileId);
    this.releaseProfileLock(profileId, profileDirectory(profileId));
    try {
      await session.context.close();
      log.info({ profile: profileId }, 'browser closed');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'error closing browser');
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  // ---------------------------------------------------------- human activity

  /**
   * Flags anything that looks like a person at the keyboard: a navigation or a
   * form POST that Nexa did not start. Without this the agent would navigate
   * away from a form you were filling in, discarding work you had just done.
   */
  private watchPage(page: Page): void {
    if (this.watchedPages.has(page)) return;
    this.watchedPages.add(page);

    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (this.ownedOperations > 0) return;
      this.noteUserActivity('navigation');
    });

    page.on('request', (request) => {
      if (this.ownedOperations > 0) return;
      if (request.method() !== 'POST') return;
      this.noteUserActivity('form submission');
    });
  }

  private noteUserActivity(reason: string): void {
    const previously = this.lastUserActivityAt;
    this.lastUserActivityAt = Date.now();
    if (!previously || Date.now() - previously > 60_000) {
      log.info({ reason }, 'browser is being used by hand; Nexa will wait');
    }
  }

  /** Marks a block of work as Nexa's own, so it is not mistaken for you. */
  async runOwned<T>(fn: () => Promise<T>): Promise<T> {
    this.ownedOperations += 1;
    try {
      return await fn();
    } finally {
      // Redirects and sub-requests land shortly after the call resolves.
      setTimeout(() => {
        this.ownedOperations = Math.max(0, this.ownedOperations - 1);
      }, 2000);
    }
  }

  userActiveWithin(ms: number): boolean {
    if (this.lastUserActivityAt === null) return false;
    return Date.now() - this.lastUserActivityAt < ms;
  }

  clearUserActivity(): void {
    this.lastUserActivityAt = null;
  }

  // ------------------------------------------------------------------- lock

  private lockFile(dir: string): string {
    return path.join(dir, '.nexa-lock');
  }

  private acquireProfileLock(profileId: string, dir: string): boolean {
    const file = this.lockFile(dir);
    try {
      if (fs.existsSync(file)) {
        const pid = Number(fs.readFileSync(file, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
          throw new ProfileInUseError(profileId, pid);
        }
        fs.rmSync(file, { force: true });
      }
      fs.writeFileSync(file, String(process.pid), 'utf8');
      return true;
    } catch (err) {
      if (err instanceof ProfileInUseError) throw err;
      log.warn({ err: (err as Error).message }, 'could not write the profile lock');
      return false;
    }
  }

  private releaseProfileLock(profileId: string, dir: string): void {
    const session = this.sessions.get(profileId);
    if (session && !session.holdsLock) return;
    try {
      const file = this.lockFile(dir);
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === String(process.pid)) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // A leftover lock is reclaimed on the next launch anyway.
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
