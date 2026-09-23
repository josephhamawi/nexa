import { describe, expect, it, vi, afterEach } from 'vitest';
import { AnthropicProvider, OpenAICompatibleProvider } from '../src/llm/providers';
import { Planner } from '../src/agent/Planner';
import { UserProfileSchema } from '../src/config/schema';
import { ToolRegistry } from '../src/tools/Tool';

afterEach(() => vi.restoreAllMocks());

function captureBody(): { body: () => Record<string, unknown> } {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {} }),
        text: async () => '',
      };
    }),
  );
  return { body: () => calls[0] as Record<string, unknown> };
}

describe('anthropic request shape', () => {
  it('never sends temperature, top_p or top_k', async () => {
    // Regression: every current Claude model answers a request carrying these
    // with a 400, which Nexa was swallowing into rule-based planning.
    const captured = captureBody();
    await new AnthropicProvider('claude-sonnet-5', 'key', {
      maxOutputTokens: 4096,
      effort: 'medium',
    }).complete({ messages: [{ role: 'user', content: 'hi' }] });

    const body = captured.body();
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('sends effort instead, which is what replaced it', async () => {
    const captured = captureBody();
    await new AnthropicProvider('claude-sonnet-5', 'key', {
      maxOutputTokens: 4096,
      effort: 'high',
    }).complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(captured.body().output_config).toEqual({ effort: 'high' });
  });
});

describe('openai-compatible request shape', () => {
  it('still sends temperature, because those servers accept it', async () => {
    const captured = captureBody();
    await new OpenAICompatibleProvider('gpt-4o', 'key', 'https://api.example.com/v1', {
      maxOutputTokens: 4096,
      temperature: 0.2,
    }).complete({ messages: [{ role: 'user', content: 'hi' }] });

    expect(captured.body().temperature).toBe(0.2);
  });
});

describe('a broken provider is reported, not hidden', () => {
  it('tells the caller when the model rejected the request', async () => {
    const failures: string[] = [];
    const broken = {
      name: 'anthropic',
      model: 'claude-sonnet-5',
      available: true,
      complete: async () => {
        throw new Error('400 Bad Request: `temperature` is deprecated for this model.');
      },
    };

    const planner = new Planner(broken as never, (reason) => failures.push(reason));
    const plan = await planner.plan('research remote AI jobs', {
      profile: UserProfileSchema.parse({}),
      tools: new ToolRegistry(),
      defaultWatchIntervalSeconds: 21_600,
    });

    // It still produces a usable plan...
    expect(plan.method).toBe('rules');
    // ...but the silent downgrade is no longer silent.
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/temperature/);
  });

  it('says nothing when there is simply no model configured', async () => {
    const failures: string[] = [];
    const none = { name: 'none', model: 'rule-based', available: false, complete: async () => ({ text: '', model: '' }) };

    const planner = new Planner(none as never, (reason) => failures.push(reason));
    await planner.plan('research remote AI jobs', {
      profile: UserProfileSchema.parse({}),
      tools: new ToolRegistry(),
      defaultWatchIntervalSeconds: 21_600,
    });

    expect(failures).toHaveLength(0);
  });
});
