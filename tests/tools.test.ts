import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { ToolRegistry } from '../src/tools/Tool';
import { FileTool } from '../src/tools/FileTool';
import { AnalysisTool } from '../src/tools/AnalysisTool';
import { WatcherTool } from '../src/tools/WatcherTool';
import { parseSearchResults, htmlToText } from '../src/tools/WebResearchTool';
import { NullProvider } from '../src/llm/providers';
import { extractJson } from '../src/llm/LLMProvider';
import { UserProfileSchema } from '../src/config/schema';
import { Permission, createTask, makeStep, TaskType } from '../src/tasks/Task';

function context(task = createTask({ name: 't', naturalLanguageRequest: 'r', type: TaskType.RESEARCH })) {
  const step = makeStep('x', 'step');
  return {
    task: { ...task, steps: [step] },
    step,
    report: vi.fn(),
    addEvidence: vi.fn((input) => ({ id: 'e', taskId: task.id, stepId: step.id, at: '', ...input })),
  };
}

afterEach(() => vi.restoreAllMocks());

describe('tool registry', () => {
  const tool = {
    name: 'demo',
    description: 'does a thing',
    inputSchema: z.object({}),
    permissions: [Permission.READ],
    mutating: false,
    execute: async () => ({ ok: true, summary: '' }),
  };

  it('registers, finds and lists tools', () => {
    const registry = new ToolRegistry();
    registry.register(tool as never);
    expect(registry.has('demo')).toBe(true);
    expect(registry.get('demo')?.description).toBe('does a thing');
    expect(registry.describeForPlanner()).toContain('- demo: does a thing');
  });

  it('refuses duplicate names, so a tool cannot be shadowed', () => {
    const registry = new ToolRegistry();
    registry.register(tool as never);
    expect(() => registry.register(tool as never)).toThrow(/already registered/);
  });
});

describe('file tool sandbox', () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-allowed-'));
  const forbidden = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-forbidden-'));
  fs.writeFileSync(path.join(allowed, 'notes.md'), '# hello\nsome notes');
  fs.writeFileSync(path.join(forbidden, 'secrets.md'), 'do not read me');

  it('reads inside an allowed folder', async () => {
    const tool = new FileTool(() => ({ allowedDirectories: [allowed], maxFileSizeMb: 25 }));
    const result = await tool.execute(
      { operation: 'read', target: path.join(allowed, 'notes.md'), sinceHours: 24, maxFiles: 10 },
      context() as never,
    );
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toContain('some notes');
  });

  it('refuses a path outside the allow-list', async () => {
    const tool = new FileTool(() => ({ allowedDirectories: [allowed], maxFileSizeMb: 25 }));
    const result = await tool.execute(
      { operation: 'read', target: path.join(forbidden, 'secrets.md'), sinceHours: 24, maxFiles: 10 },
      context() as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the directories Nexa is allowed to read/i);
    expect(result.summary).toMatch(/not allowed/i);
  });

  it('refuses traversal out of an allowed folder', async () => {
    const tool = new FileTool(() => ({ allowedDirectories: [allowed], maxFileSizeMb: 25 }));
    const result = await tool.execute(
      { operation: 'read', target: path.join(allowed, '..', path.basename(forbidden), 'secrets.md'), sinceHours: 24, maxFiles: 10 },
      context() as never,
    );
    expect(result.ok).toBe(false);
  });

  it('is disabled entirely when no folder is allowed', async () => {
    const tool = new FileTool(() => ({ allowedDirectories: [], maxFileSizeMb: 25 }));
    const result = await tool.execute({ operation: 'list', target: allowed, sinceHours: 24, maxFiles: 10 }, context() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Settings/);
  });

  it('declines binary formats rather than returning gibberish', async () => {
    fs.writeFileSync(path.join(allowed, 'doc.pdf'), '%PDF-1.4 binary');
    const tool = new FileTool(() => ({ allowedDirectories: [allowed], maxFileSizeMb: 25 }));
    const result = await tool.execute(
      { operation: 'read', target: path.join(allowed, 'doc.pdf'), sinceHours: 24, maxFiles: 10 },
      context() as never,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unsupported/i);
  });
});

describe('analysis fallback without a model', () => {
  it('ranks material by keyword overlap and explains why', async () => {
    const tool = new AnalysisTool(new NullProvider(), () => UserProfileSchema.parse({ skills: ['python'] }));
    const task = createTask({ name: 't', naturalLanguageRequest: 'r', type: TaskType.RESEARCH });
    const step = makeStep('web_research', 'search');
    const withOutput = {
      ...task,
      steps: [
        {
          ...step,
          status: 'DONE' as const,
          output: {
            findings: [
              { title: 'Python agent framework', url: 'https://a.test', excerpt: 'python agents everywhere' },
              { title: 'Knitting patterns', url: 'https://b.test', excerpt: 'wool and needles' },
            ],
          },
        },
      ],
    };

    const result = await tool.execute(
      { instruction: 'find python agent frameworks', limit: 5, useProfile: true },
      { ...context(withOutput), task: withOutput } as never,
    );

    expect(result.ok).toBe(true);
    const items = (result.data as { items: { title: string }[]; method: string }).items;
    expect(items[0].title).toBe('Python agent framework');
    expect((result.data as { method: string }).method).toBe('keyword');
  });

  it('says so plainly when there is nothing to analyse', async () => {
    const tool = new AnalysisTool(new NullProvider(), () => UserProfileSchema.parse({}));
    const result = await tool.execute({ instruction: 'rank', limit: 5, useProfile: false }, context() as never);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/Nothing to analyse/);
  });
});

describe('watcher tool', () => {
  it('raises an over-eager interval to the configured floor', async () => {
    const created: { intervalSeconds: number }[] = [];
    const tool = new WatcherTool({
      create: (input) => {
        created.push(input);
        return { ...input, id: 'w1' } as never;
      },
      list: () => [],
      setStatus: () => undefined,
      remove: () => false,
      minIntervalSeconds: () => 300,
    });

    const result = await tool.execute(
      { operation: 'create', name: '', target: 'https://example.com', type: 'WEBSITE', selector: null, keywords: [], intervalSeconds: 60, watcherId: '' },
      context() as never,
    );

    expect(result.ok).toBe(true);
    expect(created[0].intervalSeconds).toBe(300);
  });

  it('refuses to create a watcher with no target', async () => {
    const tool = new WatcherTool({
      create: () => ({}) as never,
      list: () => [],
      setStatus: () => undefined,
      remove: () => false,
      minIntervalSeconds: () => 300,
    });
    const result = await tool.execute(
      { operation: 'create', name: '', target: '', type: 'WEBSITE', selector: null, keywords: [], intervalSeconds: 3600, watcherId: '' },
      context() as never,
    );
    expect(result.ok).toBe(false);
  });
});

describe('web research parsing', () => {
  it('pulls results out of a search page and decodes redirects', () => {
    const html = `
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fagents">Agent frameworks</a>
      <a class="result__snippet">A guide to agent frameworks</a>
      <a class="result__a" href="https://other.test/page">Other</a>
      <a class="result__snippet">Second snippet</a>`;
    const hits = parseSearchResults(html);
    expect(hits[0]).toEqual({ url: 'https://example.com/agents', title: 'Agent frameworks', snippet: 'A guide to agent frameworks' });
    expect(hits[1].url).toBe('https://other.test/page');
  });

  it('reduces html to readable text', () => {
    const text = htmlToText('<html><script>evil()</script><h1>Title</h1><p>Body &amp; more</p></html>');
    expect(text).toContain('Title');
    expect(text).toContain('Body & more');
    expect(text).not.toContain('evil');
  });
});

describe('json extraction from model output', () => {
  it('handles fenced, prefixed and bare json', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(extractJson('[{"a":3}]')).toEqual([{ a: 3 }]);
  });

  it('copes with braces inside strings', () => {
    expect(extractJson('{"text":"a } b","n":4}')).toEqual({ text: 'a } b', n: 4 });
  });

  it('returns null rather than throwing on rubbish', () => {
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{broken')).toBeNull();
  });
});
