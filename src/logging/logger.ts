import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger } from 'pino';
import { ensureDataDirs, loadEnv, paths , OWNER_ONLY_FILE } from '../config/config';

/**
 * Keys that must never reach a log file or the console. Pino's redact option
 * walks the serialised object, so nesting these under any object shape is
 * still caught by the wildcard paths.
 */
const REDACTED_KEYS = [
  'password',
  'passwd',
  'pass',
  'pwd',
  'otp',
  'otpCode',
  'mfa',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'cookie',
  'cookies',
  'setCookie',
  'authorization',
  'auth',
  'captcha',
  'captchaToken',
  'captchaData',
  'CaptchaData',
  'ScriptData',
  '__RequestVerificationToken',
  'passport',
  'passportNumber',
  'cardNumber',
  'cvv',
  'telegramBotToken',
  'TELEGRAM_BOT_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'apiKey',
  'api_key',
  'secret',
];

const redactPaths = REDACTED_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);

function buildLogger(): Logger {
  const env = loadEnv();
  ensureDataDirs();

  const logFile = path.join(paths.logs, 'nexa.log');
  // Logs carry redacted records, but also URLs, task names and mail subjects.
  const fileStream = fs.createWriteStream(logFile, { flags: 'a', mode: OWNER_ONLY_FILE });

  const streams: pino.StreamEntry[] = [
    { level: env.LOG_LEVEL, stream: fileStream },
    { level: env.LOG_LEVEL, stream: process.stdout },
  ];

  return pino(
    {
      level: env.LOG_LEVEL,
      base: { app: 'nexa' },
      redact: { paths: redactPaths, censor: '[redacted]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
}

let root: Logger | null = null;

export function logger(): Logger {
  if (!root) root = buildLogger();
  return root;
}

export function childLogger(module: string): Logger {
  return logger().child({ module });
}
