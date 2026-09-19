import {
  LlmUnavailableError,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
} from './LLMProvider';
import { loadConfig, loadEnv } from '../config/config';
import { childLogger } from '../logging/logger';

const log = childLogger('llm');

const REQUEST_TIMEOUT_MS = 90_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 400);
      throw new Error(`${response.status} ${response.statusText}: ${redactSecrets(detail)}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/** Anything key-shaped is scrubbed before it can reach a log or the UI. */
function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-[redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]');
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: { maxOutputTokens: number; temperature: number },
  ) {}

  get available(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.available) throw new LlmUnavailableError('ANTHROPIC_API_KEY is not set');

    const system = request.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = request.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    const body = {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
      temperature: request.temperature ?? this.defaults.temperature,
      ...(system ? { system } : {}),
      messages,
    };

    const json = (await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      body,
    )) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const text = (json.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      text,
      model: this.model,
      inputTokens: json.usage?.input_tokens,
      outputTokens: json.usage?.output_tokens,
    };
  }
}

/** Works with OpenAI and anything that speaks its chat-completions shape. */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly defaults: { maxOutputTokens: number; temperature: number },
  ) {}

  get available(): boolean {
    return Boolean(this.baseUrl);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.available) throw new LlmUnavailableError('No OpenAI-compatible base URL configured');

    const body = {
      model: this.model,
      max_tokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
      temperature: request.temperature ?? this.defaults.temperature,
      messages: request.messages,
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
    };

    const json = (await postJson(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      body,
    )) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    return {
      text: json.choices?.[0]?.message?.content ?? '',
      model: this.model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    };
  }
}

/**
 * Stands in when no model is configured.
 *
 * Nexa stays useful without one: the planner falls back to rules, so watchers,
 * schedules and browser workflows all still run. Only the language-heavy parts
 * (free-form summarising, loose intent) degrade.
 */
export class NullProvider implements LlmProvider {
  readonly name = 'none';
  readonly model = 'rule-based';
  readonly available = false;

  async complete(): Promise<CompletionResult> {
    throw new LlmUnavailableError('No AI provider is configured');
  }
}

export function createLlmProvider(
  config = loadConfig(),
  env = loadEnv(),
): LlmProvider {
  const defaults = {
    maxOutputTokens: config.llm.maxOutputTokens,
    temperature: config.llm.temperature,
  };

  if (config.llm.provider === 'anthropic' && env.ANTHROPIC_API_KEY) {
    log.info({ model: config.llm.model }, 'using Anthropic provider');
    return new AnthropicProvider(config.llm.model, env.ANTHROPIC_API_KEY, defaults);
  }

  if (config.llm.provider === 'openai-compatible') {
    const baseUrl = config.llm.baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    log.info({ model: config.llm.model, baseUrl }, 'using OpenAI-compatible provider');
    return new OpenAICompatibleProvider(
      config.llm.model,
      env.OPENAI_API_KEY ?? '',
      baseUrl,
      defaults,
    );
  }

  log.warn('no AI provider configured; Nexa will plan with rules only');
  return new NullProvider();
}
