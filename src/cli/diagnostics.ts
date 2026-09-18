/**
 * npm run diagnostics
 *
 * Read-only health report. It loads the public portal once, looks at what it
 * finds and tells you which part of the chain is broken. It never logs in,
 * never touches a CAPTCHA and never books anything.
 */
import { chromium } from 'playwright';
import { BrowserManager } from '../browser/BrowserManager';
import { SessionManager } from '../browser/SessionManager';
import { BlsSpainAdapter } from '../bls/BlsSpainAdapter';
import { BLS_URLS, LAGOS_PATTERN, LOCATION_CONTROLS, VISA_TYPE_CONTROLS } from '../bls/BlsSelectors';
import {
  detectAuthenticated,
  detectHumanVerification,
  detectLoginRequired,
  detectSiteError,
} from '../bls/BlsPageDetector';
import { ensureDataDirs, hasTelegramCredentials, loadConfig, loadEnv, paths } from '../config/config';
import { NotificationManager } from '../notifications/NotificationManager';
import { captureScreenshot } from '../utils/screenshots';

const OK = '✓';
const BAD = '✗';
const UNKNOWN = '?';

function line(label: string, mark: string, detail: string): void {
  console.log(`${label.padEnd(22)} ${mark} ${detail}`);
}

async function main(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  const config = loadConfig();

  console.log('\nBLS SPAIN LAGOS MONITOR, DIAGNOSTICS');
  console.log('🇪🇸 Spain · 📍 Lagos, Nigeria\n');

  // ---- Playwright -----------------------------------------------------------
  try {
    const path = chromium.executablePath();
    line('Browser:', OK, `Playwright Chromium available (${path})`);
  } catch (err) {
    line('Browser:', BAD, `Playwright Chromium missing, run "npx playwright install chromium" (${(err as Error).message})`);
    process.exit(2);
  }

  // ---- Persistent session ---------------------------------------------------
  const session = new SessionManager();
  const info = session.info();
  line(
    'Persistent session:',
    info.exists ? OK : BAD,
    info.exists
      ? `exists (${info.fileCount} entries, updated ${info.lastModified ?? 'unknown'})`
      : `not configured, run "npm run login" (${paths.session})`,
  );

  // ---- Reachability + page state -------------------------------------------
  const browser = new BrowserManager(config.bls.headless);
  const adapter = new BlsSpainAdapter(browser, session, config.bls);

  let exitCode = 0;

  try {
    const page = await browser.getPage();

    // Start at the login route: the appointment route answers unauthenticated
    // requests with a 302 to a plain-http URL that never responds.
    let navError: string | null = null;
    let response = await page
      .goto(BLS_URLS.entry, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((err: Error) => {
        navError = err.message.split('\n')[0] ?? err.message;
        return null;
      });

    if (!response) {
      line('BLS website:', BAD, `could not be reached, ${navError ?? 'unknown error'}`);
      await browser.close();
      process.exit(2);
    }

    line('BLS website:', OK, `reachable (HTTP ${response.status()})`);

    // Only worth trying the appointment route if the session looks alive.
    const entrySnapshot = await adapter.snapshot(page, response.status());
    if (!detectLoginRequired(entrySnapshot).detected) {
      const appointmentResponse = await page
        .goto(BLS_URLS.myAppointments, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch(() => null);
      if (appointmentResponse) response = appointmentResponse;
    }

    const snapshot = await adapter.snapshot(page, response.status());

    const siteError = detectSiteError(snapshot);
    const verification = detectHumanVerification(snapshot);
    const login = detectLoginRequired(snapshot);
    const authed = detectAuthenticated(snapshot);

    if (siteError.detected) {
      line('Appointment page:', BAD, `site error, ${siteError.reason}`);
      exitCode = 2;
    } else if (verification.detected) {
      line('Appointment page:', BAD, `human verification on screen, ${verification.reason}`);
      exitCode = 1;
    } else if (login.detected) {
      line('Appointment page:', UNKNOWN, 'behind login');
    } else {
      line('Appointment page:', OK, 'accessible');
    }

    line(
      'Authentication:',
      authed.detected ? OK : login.detected ? BAD : UNKNOWN,
      authed.detected ? 'authenticated' : login.detected ? 'login required' : 'unknown',
    );

    if (authed.detected) {
      // Only inspect the controls; never select or submit anything here.
      const locationControl = await findControl(page, LOCATION_CONTROLS);
      const visaControl = await findControl(page, VISA_TYPE_CONTROLS);

      if (!locationControl) {
        line('Lagos:', UNKNOWN, 'no centre control on this page');
      } else {
        const options = await readOptions(page, locationControl);
        const hasLagos = options.some((o) => LAGOS_PATTERN.test(o));
        line(
          'Lagos:',
          hasLagos ? OK : BAD,
          hasLagos ? 'offered in the centre list' : `not offered (saw: ${options.slice(0, 6).join(' | ') || 'no options'})`,
        );
        if (!hasLagos) exitCode = Math.max(exitCode, 1);
      }

      if (!visaControl) {
        line('Visa category:', UNKNOWN, 'no category control on this page');
      } else {
        const options = await readOptions(page, visaControl);
        const wanted = config.bls.visaType.toLowerCase();
        const found = options.some((o) => o.toLowerCase().includes(wanted));
        line(
          'Visa category:',
          found ? OK : BAD,
          found
            ? `"${config.bls.visaType}" found`
            : `"${config.bls.visaType}" NOT found (saw: ${options.slice(0, 8).join(' | ') || 'no options'})`,
        );
        if (!found) exitCode = Math.max(exitCode, 1);
      }
    } else {
      line('Lagos:', UNKNOWN, 'cannot check until you are logged in');
      line('Visa category:', UNKNOWN, 'cannot check until you are logged in');
    }

    const shot = await captureScreenshot(page, 'diagnostics');
    if (shot) console.log(`\nScreenshot: ${shot}`);
  } finally {
    await browser.close();
  }

  // ---- Notifications --------------------------------------------------------
  const notifications = new NotificationManager(config.notifications);
  const channels = notifications.status();
  console.log('');
  line(
    'Telegram:',
    channels.telegram === 'connected' ? OK : BAD,
    channels.telegram === 'connected'
      ? 'configured'
      : channels.telegram === 'disabled'
        ? 'disabled in config.json'
        : 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in .env',
  );
  line('Desktop:', channels.desktop === 'enabled' ? OK : BAD, channels.desktop);
  line('Sound:', channels.sound === 'enabled' ? OK : BAD, channels.sound);

  if (channels.telegram === 'connected' && hasTelegramCredentials()) {
    const verified = await notifications.telegram.verify();
    line('Telegram bot:', verified.ok ? OK : BAD, verified.ok ? `@${verified.botName ?? 'bot'}` : String(verified.error));
  }

  console.log('');
  process.exit(exitCode);
}

/** Minimal duplicates of the adapter's helpers, diagnostics stays read-only. */
async function findControl(
  page: import('playwright').Page,
  strategies: typeof LOCATION_CONTROLS,
): Promise<import('playwright').Locator | null> {
  for (const strategy of strategies) {
    if (strategy.kind !== 'css') continue;
    const locator = page.locator(strategy.selector).first();
    if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) return locator;
  }
  return null;
}

async function readOptions(
  page: import('playwright').Page,
  control: import('playwright').Locator,
): Promise<string[]> {
  const tag = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'select') {
    return control
      .evaluate((el) =>
        Array.from((el as HTMLSelectElement).options)
          .map((o) => (o.textContent ?? '').trim())
          .filter(Boolean),
      )
      .catch(() => []);
  }
  return page
    .locator('[role="option"], .k-list-item, .k-item')
    .allTextContents()
    .then((values) => values.map((v) => v.trim()).filter(Boolean))
    .catch(() => []);
}

main().catch((err: Error) => {
  console.error(`diagnostics failed: ${err.message}`);
  process.exit(2);
});
