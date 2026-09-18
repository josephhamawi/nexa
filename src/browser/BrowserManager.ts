import fs from 'node:fs';
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
export class BrowserManager {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launching: Promise<BrowserContext> | null = null;

  constructor(private readonly headless = false) {}

  isRunning(): boolean {
    return this.context !== null;
  }

  async launch(): Promise<BrowserContext> {
    if (this.context) return this.context;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      ensureDataDirs();
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
    if (!context) return;
    try {
      await context.close();
      log.info('browser closed');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'error closing browser');
    }
  }

  static profileExists(): boolean {
    return fs.existsSync(paths.session) && fs.readdirSync(paths.session).length > 0;
  }
}
