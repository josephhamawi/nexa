import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { AppConfigSchema, EnvSchema, type AppConfig, type Env } from './schema';

/**
 * Resolves the project root by walking up from this file until a package.json
 * is found. Works from src/ (tsx), dist/ (tsc output) and from Electron, where
 * process.cwd() is not reliable.
 */
function findProjectRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PROJECT_ROOT = findProjectRoot();

/**
 * A packaged Electron build cannot write inside its own bundle, so
 * src/main/appPaths.ts points these at the userData directory before anything
 * else loads. Getters (not constants) are what make that late override work.
 */
function dataRoot(): string {
  return process.env.BLS_DATA_DIR
    ? path.resolve(process.env.BLS_DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');
}

export const paths = {
  get root(): string {
    return PROJECT_ROOT;
  },
  get config(): string {
    return process.env.BLS_CONFIG_PATH
      ? path.resolve(process.env.BLS_CONFIG_PATH)
      : path.join(PROJECT_ROOT, 'config.json');
  },
  get env(): string {
    return process.env.BLS_ENV_PATH
      ? path.resolve(process.env.BLS_ENV_PATH)
      : path.join(PROJECT_ROOT, '.env');
  },
  get data(): string {
    return dataRoot();
  },
  get session(): string {
    return path.join(dataRoot(), 'sessions', 'bls-spain-lagos');
  },
  get screenshots(): string {
    return path.join(dataRoot(), 'screenshots', 'bls-spain-lagos');
  },
  get logs(): string {
    return path.join(dataRoot(), 'logs');
  },
  get state(): string {
    return path.join(dataRoot(), 'state');
  },
  get stateFile(): string {
    return path.join(dataRoot(), 'state', 'monitor-state.json');
  },
  get eventsFile(): string {
    return path.join(dataRoot(), 'state', 'events.jsonl');
  },
};

export function ensureDataDirs(): void {
  for (const dir of [paths.data, paths.session, paths.screenshots, paths.logs, paths.state]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

let cachedEnv: Env | null = null;

export function loadEnv(): Env {
  if (cachedEnv) return cachedEnv;
  dotenv.config({ path: paths.env });
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${formatZodError(parsed.error.issues)}`);
  }
  cachedEnv = parsed.data;
  return cachedEnv;
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cachedConfig && !force) return cachedConfig;
  let raw: unknown = {};
  if (fs.existsSync(paths.config)) {
    const text = fs.readFileSync(paths.config, 'utf8');
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
    }
  }
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config.json:\n${formatZodError(parsed.error.issues)}`);
  }
  cachedConfig = parsed.data;
  return cachedConfig;
}

export function saveConfig(next: AppConfig): AppConfig {
  const parsed = AppConfigSchema.parse(next);
  fs.writeFileSync(paths.config, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  cachedConfig = parsed;
  return parsed;
}

function formatZodError(issues: { path: (string | number | symbol)[]; message: string }[]): string {
  return issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

export function hasTelegramCredentials(env: Env = loadEnv()): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
}

/** Drops the cache so the next loadEnv() re-reads the file. */
export function reloadEnv(): Env {
  cachedEnv = null;
  return loadEnv();
}

/**
 * Writes Telegram credentials to the .env file, preserving any other keys and
 * comments already in it.
 *
 * These are bot credentials the user creates for themselves, not a BLS login:
 * the application needs them to send you messages. They are written with
 * owner-only permissions and are never logged or echoed back to the UI.
 */
export function writeEnvValues(values: Record<string, string>): void {
  const file = paths.env;
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(values));

  const updated = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match) return line;
    const key = match[1] as string;
    if (!remaining.has(key)) return line;
    const value = remaining.get(key) as string;
    remaining.delete(key);
    return `${key}=${value}`;
  });

  for (const [key, value] of remaining) updated.push(`${key}=${value}`);

  const body = `${updated.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });

  // Keep the running process in step with what was just written.
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  reloadEnv();
}
