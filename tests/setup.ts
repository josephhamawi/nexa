/**
 * Test environment.
 *
 * Fake Telegram credentials are injected so the notifier's code paths can run
 * against a stubbed fetch. No test in this suite contacts BLS or Telegram.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY-XXXXXX';
process.env.TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '42424242';
