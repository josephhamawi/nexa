import { describe, expect, it, vi } from 'vitest';
import { AnalysisTool } from '../src/tools/AnalysisTool';
import { NullProvider } from '../src/llm/providers';
import { UserProfileSchema } from '../src/config/schema';
import { createTask, makeStep, TaskType, type TaskStep } from '../src/tasks/Task';

function contextWith(steps: TaskStep[]) {
  const task = createTask({ name: 't', naturalLanguageRequest: 'summarize my mail', type: TaskType.REPORT });
  const step = makeStep('analyze', 'analyse');
  return {
    task: { ...task, steps: [...steps, step] },
    step,
    report: vi.fn(),
    addEvidence: vi.fn(),
  };
}

function doneStep(tool: string, output: unknown, summary?: string): TaskStep {
  return { ...makeStep(tool, tool), status: 'DONE', output, summary } as TaskStep;
}

const tool = new AnalysisTool(new NullProvider(), () => UserProfileSchema.parse({}));
const ask = { instruction: 'Summarize the messages', limit: 10, useProfile: false };

describe('analysing an empty result', () => {
  it('does not fail the task when an earlier step ran and found nothing', async () => {
    // Regression: "Summarize today's Hotmail emails" failed outright with
    // "no input material" because mail_read legitimately returned zero
    // messages. An empty inbox is an answer, not a crash.
    const ctx = contextWith([
      doneStep('mail_read', { items: [], count: 0 }, 'No mail today in joseph@hotmail.com.'),
    ]);

    const result = await tool.execute(ask, ctx as never);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/No mail today/);
  });

  it('still fails when nothing ran at all, which is a real problem', async () => {
    const result = await tool.execute(ask, contextWith([]) as never);

    expect(result.ok).toBe(false);
    expect(result.error).toBe('no input material');
  });

  it('falls back to plain wording when the earlier step gave no summary', async () => {
    const ctx = contextWith([doneStep('mail_read', { items: [] })]);
    const result = await tool.execute(ask, ctx as never);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('There was nothing to report.');
  });

  it('titles mail by its subject instead of calling every message "Item"', async () => {
    const ctx = contextWith([
      doneStep('mail_read', {
        items: [{ subject: 'Invoice #42', sender: 'billing@acme.com', account: 'work' }],
      }),
    ]);

    // The instruction has to share a word with the material: without a model,
    // ranking is keyword-based and drops anything scoring zero.
    const result = await tool.execute({ ...ask, instruction: 'Summarize the invoice' }, ctx as never);
    const items = (result.data as { items: { title: string }[] }).items;
    expect(items[0]?.title).toBe('Invoice #42');
  });
});
