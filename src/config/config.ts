import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { AppConfigSchema, EnvSchema, type AppConfig, type Env } from './schema';

export type { AppConfig, Env } from './schema';

/**
 * Resolves the project root by walking up until a package.json is found.
 * Works from src/ (tsx), dist/ (tsc output) and from Electron, where
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
 * A packaged build cannot write inside its own bundle, so main/appPaths.ts
 * points these at the userData directory before anything else loads. Getters
 * (not constants) are what make that late override work.
 */
function dataRoot(): string {
  return process.env.NEXA_DATA_DIR
    ? path.resolve(process.env.NEXA_DATA_DIR)
    : path.join(PROJECT_ROOT, 'data');
}

export const paths = {
  get root(): string {
    return PROJECT_ROOT;
  },
  get config(): string {
    return process.env.NEXA_CONFIG_PATH
      ? path.resolve(process.env.NEXA_CONFIG_PATH)
      : path.join(PROJECT_ROOT, 'config.json');
  },
  get configExample(): string {
    return path.join(PROJECT_ROOT, 'config.example.json');
  },
  get env(): string {
    return process.env.NEXA_ENV_PATH
      ? path.resolve(process.env.NEXA_ENV_PATH)
      : path.join(PROJECT_ROOT, '.env');
  },
  get data(): string {
    return dataRoot();
  },
  /** One persistent browser profile directory per configured profile. */
  get profiles(): string {
    return path.join(dataRoot(), 'profiles');
  },
  /** Screenshots and extracted payloads that back up a task's claims. */
  get evidence(): string {
    return path.join(dataRoot(), 'evidence');
  },
  get logs(): string {
    return path.join(dataRoot(), 'logs');
  },
  get state(): string {
    return path.join(dataRoot(), 'state');
  },
  get tasksFile(): string {
    return path.join(dataRoot(), 'state', 'tasks.json');
  },
  get watchersFile(): string {
    return path.join(dataRoot(), 'state', 'watchers.json');
  },
  get memoryFile(): string {
    return path.join(dataRoot(), 'state', 'memory.json');
  },
  get telegramOffsetFile(): string {
    return path.join(dataRoot(), 'state', 'telegram-offset.json');
  },
  get activityFile(): string {
    return path.join(dataRoot(), 'state', 'activity.jsonl');
  },
};

export function profileDirectory(profileId: string): string {
  return path.join(paths.profiles, profileId.replace(/[^a-z0-9_-]/gi, '_'));
}

export function ensureDataDirs(): void {
  for (const dir of [paths.data, paths.profiles, paths.evidence, paths.logs, paths.state]) {
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

export function reloadEnv(): Env {
  cachedEnv = null;
  return loadEnv();
}

/**
 * Writes secrets to the .env file, preserving other keys and comments.
 * Owner-only permissions; values are never logged or echoed back to the UI.
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

  for (const [key, value] of Object.entries(values)) process.env[key] = value;
  reloadEnv();
}

let cachedConfig: AppConfig | null = null;

export function loadConfig(force = false): AppConfig {
  if (cachedConfig && !force) return cachedConfig;

  // A fresh clone has no config.json (it holds your own preferences and is
  // gitignored), so seed it from the template on first run.
  if (!fs.existsSync(paths.config) && fs.existsSync(paths.configExample)) {
    try {
      fs.copyFileSync(paths.configExample, paths.config);
    } catch {
      // Not fatal: every field in the schema has a default.
    }
  }

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
  ensureDataDirs();
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

export function hasLlmCredentials(config: AppConfig = loadConfig(), env: Env = loadEnv()): boolean {
  if (config.llm.provider === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY);
  if (config.llm.provider === 'openai-compatible') {
    return Boolean(env.OPENAI_API_KEY || config.llm.baseUrl || env.OPENAI_BASE_URL);
  }
  return false;
}
