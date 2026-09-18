/**
 * npm run login
 *
 * Opens the persistent Chromium profile on the BLS Spain Nigeria portal so you
 * can sign in yourself.
 *
 * The application never types your credentials, never reads them, never stores
 * them, and never touches the CAPTCHA. It only watches the page to tell you
 * when the session looks authenticated, and keeps the profile on disk so you
 * do not have to repeat this after every restart.
 */
import { BrowserManager } from '../browser/BrowserManager';
import { SessionManager } from '../browser/SessionManager';
import { BlsSpainAdapter } from '../bls/BlsSpainAdapter';
import { BLS_URLS } from '../bls/BlsSelectors';
import { detectAuthenticated, detectHumanVerification, detectLoginRequired } from '../bls/BlsPageDetector';
import { ensureDataDirs, loadConfig, loadEnv, paths } from '../config/config';
import { sleep } from '../utils/time';

async function main(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  const config = loadConfig();

  const browser = new BrowserManager(false);
  const session = new SessionManager();
  const adapter = new BlsSpainAdapter(browser, session, config.bls);

  console.log('\n🇪🇸  BLS Spain in Lagos, Nigeria');
  console.log(`Profile: ${paths.session}\n`);

  const page = await browser.getPage();
  await page.goto(BLS_URLS.login, { waitUntil: 'domcontentloaded' }).catch((err: Error) => {
    console.error(`Could not open the BLS portal: ${err.message}`);
  });

  console.log('Chromium is open. Please:');
  console.log('  1. Enter your BLS user id and password IN THE BROWSER (never in this terminal).');
  console.log('  2. Complete the CAPTCHA / verification yourself.');
  console.log('  3. Leave the window open until this script confirms the session.\n');
  console.log('Press Ctrl+C when you are done.\n');

  let lastLine = '';
  let authenticatedSince: number | null = null;

  const closed = new Promise<void>((resolve) => {
    page.on('close', () => resolve());
    process.on('SIGINT', () => resolve());
  });

  const poll = (async () => {
    for (;;) {
      await sleep(4000);
      if (page.isClosed()) return;

      let line: string;
      try {
        const snapshot = await adapter.snapshot(page, null);
        const verification = detectHumanVerification(snapshot);
        const login = detectLoginRequired(snapshot);
        const authed = detectAuthenticated(snapshot);

        if (verification.detected) {
          line = '⏳ Human verification is on screen. Complete it in the browser.';
          authenticatedSince = null;
        } else if (authed.detected && !login.detected) {
          if (authenticatedSince === null) authenticatedSince = Date.now();
          line = '✓ BLS session appears authenticated.';
        } else if (login.detected) {
          line = '… Waiting for you to sign in.';
          authenticatedSince = null;
        } else {
          line = '… Page state unclear. Navigate to My Appointments to confirm.';
        }
      } catch {
        line = '… Page is navigating.';
      }

      if (line !== lastLine) {
        console.log(line);
        lastLine = line;
      }

      if (authenticatedSince && Date.now() - authenticatedSince > 8000) {
        session.setStatus('AUTHENTICATED');
        console.log('\nSession saved to the persistent profile.');
        console.log('You can close the browser window, or leave it open and start monitoring.');
        authenticatedSince = null;
      }
    }
  })();

  await Promise.race([closed, poll]);

  console.log('\nClosing browser and keeping the session on disk…');
  await browser.close();
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`login failed: ${err.message}`);
  process.exit(1);
});
