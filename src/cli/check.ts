/**
 * npm run check
 *
 * Runs exactly one availability check and prints the normalised result.
 * Exit code 0 = the site gave an answer, 1 = manual action needed,
 * 2 = error / could not interpret the page.
 */
import { BrowserManager } from '../browser/BrowserManager';
import { SessionManager } from '../browser/SessionManager';
import { BlsSpainAdapter } from '../bls/BlsSpainAdapter';
import { AvailabilityStatus, isErrorStatus, requiresManualAction } from '../availability/AvailabilityState';
import { ensureDataDirs, loadConfig, loadEnv } from '../config/config';

async function main(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  const config = loadConfig();

  const browser = new BrowserManager(config.bls.headless);
  const session = new SessionManager();
  const adapter = new BlsSpainAdapter(browser, session, config.bls);

  console.log('Checking BLS Spain in Lagos, Nigeria…\n');
  const result = await adapter.check();

  console.log(JSON.stringify(result, null, 2));

  const keepOpen = result.status === AvailabilityStatus.AVAILABLE || result.requiresManualAction;
  if (keepOpen) {
    console.log('\nThe browser has been left open for you to continue manually.');
    console.log('Press Ctrl+C when you are done.');
    await new Promise<void>((resolve) => process.on('SIGINT', () => resolve()));
  }

  await browser.close();

  if (requiresManualAction(result.status)) process.exit(1);
  if (isErrorStatus(result.status)) process.exit(2);
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`check failed: ${err.message}`);
  process.exit(2);
});
