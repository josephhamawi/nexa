/**
 * The boundary between Nexa and whichever model is configured.
 *
 * Business logic depends on this interface only, never on a vendor SDK, so a
 * provider can be swapped in configuration without touching the orchestrator.
 * Nexa also has to work with no provider at all, which is why every caller
 * must handle `available === false` rather than assuming a model is there.
 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionRequest {
  messages: LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  /** Ask for strict JSON back. Providers enforce it however they can. */
  json?: boolean;
}

export interface CompletionResult {
  text: string;
  model: string;
  /** Rough token accounting, when the provider reports it. */
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens served from the prompt cache, at about a tenth the price. */
  cachedInputTokens?: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** False when no key is configured; callers must fall back to rules. */
  readonly available: boolean;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

/**
 * Pulls the first JSON object or array out of a model response.
 *
 * Models wrap JSON in prose or fences even when told not to, and a planner
 * that throws on that is a planner that fails in production.
 */
export function extractJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;

    const opening = trimmed[start] as '[' | '{';
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < trimmed.length; i += 1) {
      const char = trimmed[i] as string;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = !inString;
      if (inString) continue;
      if (char === opening) depth += 1;
      if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1)) as T;
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}
