import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { ensureDataDirs, paths } from '../config/config';
import { childLogger } from '../logging/logger';

const log = childLogger('browser');

/**
 * Owns the single persistent Chromium context used by the whole application.
 *
 * Deliberately plain:
 *   - stock Playwright Chromium, stock user agent, stock fingerprint
 *   - no stealth plugin, no fingerprint patching, no webdriver masking
 *   - one context, one page; parallel scraping is not supported by design
 *
 * The persistent profile in data/sessions/bls-spain-lagos/ is what keeps you
 * logged in between runs, Playwright stores BLS's own cookies there, and
 * nothing is copied out of it.
 */
/**
 * Raised when a second process tries to drive the same persistent profile.
 *
 * Two Chromiums sharing one profile directory fight over the cookie store, and
 * the loser silently loses its BLS session: you sign in, and moments later the
 * portal has signed you out again. The lock below makes that impossible.
 */
export class ProfileInUseError extends Error {
  constructor(pid: number) {
    super(
      `The browser profile is already in use by process ${pid}. ` +
        'Quit the running monitor (or CLI command) before starting another one; ' +
        'two Chromiums on one profile would log each other out of BLS.',
    );
    this.name = 'ProfileInUseError';
  }
}

export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launching: Promise<BrowserContext> | null = null;
  private holdsLock = false;

  constructor(private readonly headless = false) {}

  isRunning(): boolean {
    return this.context !== null;
  }

  async launch(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      ensureDataDirs();
      this.acquireProfileLock();
      log.info({ profile: paths.session, headless: this.headless }, 'launching persistent Chromium');

      const context = await chromium.launchPersistentContext(paths.session, {
        headless: this.headless,
        viewport: null,
        acceptDownloads: false,
        // Keep the real browser locale/timezone semantics; en-GB matches the
        // date ordering BLS Nigeria renders.
        locale: 'en-GB',
        args: ['--start-maximized'],
      });

      // The BLS portal is slow: the login page regularly takes 15-25 seconds.
      context.setDefaultTimeout(30_000);
      context.setDefaultNavigationTimeout(60_000);

      /**
       * tsx/esbuild rewrites named function expressions to call a `__name`
       * helper. page.evaluate ships the transpiled source into the page, where
       * that helper does not exist, so every evaluate would throw when running
       * the CLI entry points. Defining it as identity fixes that; the compiled
       * (tsc) build never emits `__name`, so this is a harmless no-op there.
       */
      await context.addInitScript(() => {
        const globalObject = globalThis as unknown as Record<string, unknown>;
        if (typeof globalObject.__name !== 'function') {
          globalObject.__name = (value: unknown): unknown => value;
        }
      });

      context.on('close', () => {
        log.warn('browser context closed');
        this.context = null;
        this.page = null;
        this.releaseProfileLock();
      });

      this.context = context;
      return context;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /** The single working page. Reused across checks so the session stays warm. */
  async getPage(): Promise<Page> {
    const context = await this.launch();
    if (this.page && !this.page.isClosed()) return this.page;

    const existing = context.pages().find((p) => !p.isClosed());
    const page = existing ?? (await context.newPage());

    // A freshly launched context may still be committing its initial
    // about:blank navigation. Navigating on top of that races and fails with
    // "interrupted by another navigation", so let it settle first.
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);

    this.page = page;
    return this.page;
  }

  currentPage(): Page | null {
    return this.page && !this.page.isClosed() ? this.page : null;
  }

  /** Raises the Chromium window so the user can act on a CAPTCHA or a slot. */
  async bringToFront(): Promise<void> {
    const page = this.currentPage();
    if (!page) return;
    try {
      await page.bringToFront();
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'bringToFront failed');
    }
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.releaseProfileLock();
    if (!context) return;
    try {
      await context.close();
      log.info('browser closed');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'error closing browser');
    }
  }

  private lockFile(): string {
    return path.join(paths.session, '.monitor-lock');
  }

  /** Refuses to launch when another live process owns the profile. */
  private acquireProfileLock(): void {
    const file = this.lockFile();
    try {
      if (fs.existsSync(file)) {
        const pid = Number(fs.readFileSync(file, 'utf8').trim());
        if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
          throw new ProfileInUseError(pid);
        }
        // Stale lock from a crash: reclaim it.
        fs.rmSync(file, { force: true });
      }
      fs.writeFileSync(file, String(process.pid), 'utf8');
      this.holdsLock = true;
    } catch (err) {
      if (err instanceof ProfileInUseError) throw err;
      log.warn({ err: (err as Error).message }, 'could not write the profile lock');
    }
  }

  private releaseProfileLock(): void {
    if (!this.holdsLock) return;
    this.holdsLock = false;
    try {
      const file = this.lockFile();
      if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === String(process.pid)) {
        fs.rmSync(file, { force: true });
      }
    } catch {
      // A leftover lock is reclaimed on the next launch anyway.
    }
  }

  static profileExists(): boolean {
    return fs.existsSync(paths.session) && fs.readdirSync(paths.session).length > 0;
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
