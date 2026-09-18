/**
 * npm run test:telegram
 *
 * Verifies the bot credentials and sends one test message to your chat.
 */
import { ensureDataDirs, hasTelegramCredentials, loadConfig, loadEnv } from '../config/config';
import { NotificationManager } from '../notifications/NotificationManager';

async function main(): Promise<void> {
  ensureDataDirs();
  loadEnv();
  const config = loadConfig();

  if (!hasTelegramCredentials()) {
    console.error('✗ TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are not set in .env');
    console.error('  Copy .env.example to .env and fill both values.');
    process.exit(1);
  }

  const notifications = new NotificationManager({ ...config.notifications, telegram: true });

  const verified = await notifications.telegram.verify();
  if (!verified.ok) {
    console.error(`✗ Could not verify the bot: ${verified.error}`);
    process.exit(1);
  }
  console.log(`✓ Bot verified${verified.botName ? ` (@${verified.botName})` : ''}`);

  const outcome = await notifications.test();
  if (outcome.telegram.ok) {
    console.log('✓ Test message sent. Check your Telegram chat.');
  } else {
    console.error(`✗ Telegram send failed: ${outcome.telegram.error}`);
    process.exit(1);
  }

  console.log(`  Desktop notification: ${outcome.desktop ? '✓ sent' : '✗ not sent'}`);
  console.log(`  Sound: ${outcome.sound ? '✓ played' : '✗ not played'}`);
  process.exit(0);
}

main().catch((err: Error) => {
  console.error(`test:telegram failed: ${err.message}`);
  process.exit(1);
});
