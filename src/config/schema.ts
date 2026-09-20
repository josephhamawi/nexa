import { z } from 'zod';

/**
 * Nexa configuration.
 *
 * Everything here is operational preference. Secrets (API keys, bot tokens)
 * live in the environment, never in this file.
 */

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

export const LlmConfigSchema = z.object({
  /** Which provider implementation to use. "none" keeps Nexa rule-driven. */
  provider: z.enum(['anthropic', 'openai-compatible', 'none']).default('anthropic'),
  model: z.string().default('claude-sonnet-5'),
  /** Upper bound on a single completion, to keep costs predictable. */
  maxOutputTokens: z.number().int().min(256).max(32_000).default(4096),
  temperature: z.number().min(0).max(1).default(0.2),
  /** Base URL for OpenAI-compatible servers (Ollama, vLLM, LM Studio, …). */
  baseUrl: z.string().default(''),
});

export const TelegramConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Poll interval for incoming messages, in seconds. */
  pollSeconds: z.number().int().min(1).max(60).default(3),
  /** Only these chat ids may command Nexa. Empty = only TELEGRAM_CHAT_ID. */
  allowedChatIds: z.array(z.string()).default([]),
});

export const BrowserProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  engine: z.enum(['chromium', 'firefox', 'webkit']).default('chromium'),
  headless: z.boolean().default(false),
  createdAt: z.string().default(() => new Date().toISOString()),
  lastUsed: z.string().nullable().default(null),
});

/**
 * An MCP server Nexa may borrow tools from.
 *
 * The command and arguments come from this file only: nothing the model
 * produces is ever executed as a shell command. `permissions` is the grant
 * every tool from that server runs under, so a filesystem server can be given
 * FILES without also being given BROWSER.
 */
export const McpServerSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_-]+$/i, 'letters, digits, dash and underscore only'),
  name: z.string().default(''),
  enabled: z.boolean().default(true),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** Extra environment for the server process, e.g. an API token. */
  env: z.record(z.string()).default({}),
  permissions: z
    .array(z.enum(['READ', 'RESEARCH', 'BROWSER', 'FILES', 'EXECUTE', 'NOTIFY']))
    .default(['READ']),
  /** Seconds before a call to this server is abandoned. */
  timeoutSeconds: z.number().int().min(5).max(300).default(45),
});

export const AgentConfigSchema = z.object({
  /** Tasks executed concurrently. One keeps ordering obvious and sites happy. */
  maxConcurrentTasks: z.number().int().min(1).max(5).default(1),
  /** Attempts per step before a task is parked as FAILED. */
  maxStepRetries: z.number().int().min(0).max(5).default(2),
  /** Polite floor between watcher checks, in seconds. */
  minWatchIntervalSeconds: z.number().int().min(60).max(86_400).default(300),
  /** Steps that change state elsewhere need a human yes before running. */
  requireApprovalForWrites: z.boolean().default(true),
  /** Nothing leaves the machine and no site is contacted for real. */
  demoMode: z.boolean().default(false),
});

export const UserProfileSchema = z.object({
  name: z.string().default(''),
  summary: z.string().default(''),
  skills: z.array(z.string()).default([]),
  technologies: z.array(z.string()).default([]),
  preferredRoles: z.array(z.string()).default([]),
  excludedRoles: z.array(z.string()).default([]),
  industries: z.array(z.string()).default([]),
  locations: z.array(z.string()).default([]),
  remotePreference: z.enum(['remote', 'hybrid', 'onsite', 'any']).default('remote'),
  salaryMin: z.number().int().min(0).default(0),
  salaryCurrency: z.string().default('USD'),
  interests: z.array(z.string()).default([]),
});

export const FilesConfigSchema = z.object({
  /**
   * Directories the file tool may read. Empty means the file tool is disabled.
   * Nexa never reads outside this list, whatever a task asks for.
   */
  allowedDirectories: z.array(z.string()).default([]),
  maxFileSizeMb: z.number().int().min(1).max(200).default(25),
});

export const NotificationsConfigSchema = z.object({
  telegram: z.boolean().default(true),
  desktop: z.boolean().default(true),
  sound: z.boolean().default(true),
  /** Send one consolidated briefing at this local time. Empty disables it. */
  dailyBriefAt: z.union([z.literal(''), timeOfDay]).default(''),
});

export const AppConfigSchema = z.object({
  llm: LlmConfigSchema.default({}),
  telegram: TelegramConfigSchema.default({}),
  agent: AgentConfigSchema.default({}),
  files: FilesConfigSchema.default({}),
  notifications: NotificationsConfigSchema.default({}),
  userProfile: UserProfileSchema.default({}),
  mcpServers: z.array(McpServerSchema).default([]),
  browserProfiles: z.array(BrowserProfileSchema).default([
    {
      id: 'default',
      name: 'Default',
      engine: 'chromium',
      headless: false,
      createdAt: new Date().toISOString(),
      lastUsed: null,
    },
  ]),
});

export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>;
export type BrowserProfile = z.infer<typeof BrowserProfileSchema>;
export type McpServerConfig = z.infer<typeof McpServerSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type FilesConfig = z.infer<typeof FilesConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  TELEGRAM_CHAT_ID: z.string().trim().optional(),
  ANTHROPIC_API_KEY: z.string().trim().optional(),
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.string().trim().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;
