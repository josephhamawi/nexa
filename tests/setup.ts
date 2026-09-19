/**
 * Test environment.
 *
 * Fake credentials so the code paths can run against stubs, and a scratch data
 * directory so tests never touch your real tasks, watchers or browser profiles.
 * No test in this suite contacts the network.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-test-'));

process.env.NEXA_DATA_DIR = scratch;
process.env.NEXA_CONFIG_PATH = path.join(scratch, 'config.json');
process.env.NEXA_ENV_PATH = path.join(scratch, '.env');
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.TELEGRAM_BOT_TOKEN = '123456789:TEST-TOKEN-FOR-UNIT-TESTS-ONLY-XXXXXX';
process.env.TELEGRAM_CHAT_ID = '42424242';
