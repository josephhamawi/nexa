/**
 * npm run monitor
 *
 * Headless-of-Electron monitoring loop: the same MonitorManager the dashboard
 * drives, with the event log printed to the terminal.
 */
import { ensureDataDirs, loadConfig, loadEnv } from '../config/config';
import { MonitorManager } from '../monitoring/MonitorManager';

async function main(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  const config = loadConfig();

  const monitor = new MonitorManager(config);

  console.log('\n🇪🇸  BLS SPAIN APPOINTMENT MONITOR');
  console.log('📍  Lagos, Nigeria');
  console.log(`    Visa: ${config.bls.visaType}`);
  console.log(
    `    Interval: ${config.bls.intervalMinSeconds}-${config.bls.intervalMaxSeconds}s (randomised)\n`,
  );

  monitor.on('event', (event: { clock: string; source: string; message: string }) => {
    console.log(`${event.clock}  ${event.source.padEnd(11)}  ${event.message}`);
  });

  monitor.on('appointment-found', () => {
    console.log('\n🚨  APPOINTMENT FOUND. Monitoring stopped, browser left open.\n');
  });

  monitor.on('manual-action-required', () => {
    console.log('\n⚠  Manual action required in the browser. Monitoring is paused.');
    console.log('   Finish the step, then restart this command to resume.\n');
  });

  const shutdown = async (): Promise<void> => {
    console.log('\nStopping…');
    await monitor.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await monitor.start();
}

main().catch((err: Error) => {
  console.error(`monitor failed: ${err.message}`);
  process.exit(1);
});
