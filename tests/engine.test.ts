import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { TaskEngine } from '../src/tasks/TaskEngine';
import { ToolRegistry, assertPermitted, PermissionDeniedError, type Tool } from '../src/tools/Tool';
import { ActivityLog } from '../src/agent/ActivityLog';
import { EvidenceStore } from '../src/evidence/EvidenceStore';
import { NotificationManager } from '../src/notifications/NotificationManager';
import { Permission, TaskStatus, createTask, makeStep, TaskType } from '../src/tasks/Task';
import { paths } from '../src/config/config';
import { z } from 'zod';

const silentNotifications = new NotificationManager({
  telegram: false,
  desktop: false,
  sound: false,
  dailyBriefAt: '',
});

function tool(name: string, handler: () => Promise<unknown>, opts: Partial<Tool<Record<string, never>>> = {}) {
  return {
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permissions: [Permission.READ],
    mutating: false,
    execute: async () => {
      const result = await handler();
      return result as never;
    },
    ...opts,
  } as unknown as Tool<Record<string, never>>;
}

function engineWith(tools: Tool<never>[]) {
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t as never);
  return new TaskEngine(registry, new EvidenceStore(), silentNotifications, new ActivityLog(), {
    maxStepRetries: 1,
    requireApprovalForWrites: true,
    isBrowserBusy: () => false,
  });
}

function researchTask(steps = [makeStep('ok', 'Step one')]) {
  return createTask({
    name: 'Test task',
    naturalLanguageRequest: 'do the thing',
    type: TaskType.RESEARCH,
    steps,
    permissions: [Permission.READ],
  });
}

afterEach(() => {
  // Each test starts from an empty store.
  for (const file of [paths.tasksFile, paths.watchersFile]) {
    if (fs.existsSync(file)) fs.rmSync(file);
  }
  vi.restoreAllMocks();
});

describe('task execution', () => {
  it('runs every step and completes', async () => {
    const engine = engineWith([tool('ok', async () => ({ ok: true, summary: 'done', data: { items: [] } }))]);
    const task = engine.add(researchTask([makeStep('ok', 'One'), makeStep('ok', 'Two')]));
    engine.enqueue(task.id);

    const finished = await engine.run(task.id);
    expect(finished?.status).toBe(TaskStatus.COMPLETED);
    expect(finished?.progress).toBe(100);
    expect(finished?.steps.every((step) => step.status === 'DONE')).toBe(true);
  });

  it('retries a failing step then gives up cleanly', async () => {
    let attempts = 0;
    const engine = engineWith([
      tool('flaky', async () => {
        attempts += 1;
        return { ok: false, summary: 'nope', error: 'boom' };
      }),
    ]);
    const task = engine.add(researchTask([makeStep('flaky', 'Try')]));
    engine.enqueue(task.id);

    const finished = await engine.run(task.id);
    expect(attempts).toBe(2); // one attempt plus one retry
    expect(finished?.status).toBe(TaskStatus.FAILED);
    expect(finished?.errors[0]?.message).toBe('boom');
  });

  it('recovers when a step succeeds on the retry', async () => {
    let attempts = 0;
    const engine = engineWith([
      tool('flaky', async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, summary: 'first fails', error: 'transient' } : { ok: true, summary: 'second works' };
      }),
    ]);
    const task = engine.add(researchTask([makeStep('flaky', 'Try')]));
    engine.enqueue(task.id);

    const finished = await engine.run(task.id);
    expect(finished?.status).toBe(TaskStatus.COMPLETED);
  });

  it('parks for a human instead of failing when a site needs one', async () => {
    const engine = engineWith([
      tool('blocked', async () => ({
        ok: false,
        summary: 'needs a person',
        needsHuman: { reason: 'CAPTCHA on the page', url: 'https://example.com' },
      })),
    ]);
    const task = engine.add(researchTask([makeStep('blocked', 'Open site')]));
    engine.enqueue(task.id);

    const parked = await engine.run(task.id);
    expect(parked?.status).toBe(TaskStatus.WAITING_FOR_HUMAN);
    // The step stays pending so it runs again after the takeover.
    expect(parked?.steps[0]?.status).toBe('PENDING');

    const resumed = engine.resume(task.id);
    expect(resumed?.status).toBe(TaskStatus.QUEUED);
  });

  it('asks for approval before a mutating step and continues once approved', async () => {
    const engine = engineWith([
      tool('writes', async () => ({ ok: true, summary: 'wrote' }), { mutating: true, permissions: [Permission.EXECUTE] }),
    ]);
    const task = engine.add({
      ...researchTask([makeStep('writes', 'Submit the form')]),
      approvalRequired: true,
      permissions: [Permission.READ, Permission.EXECUTE],
    });
    engine.enqueue(task.id);

    const waiting = await engine.run(task.id);
    expect(waiting?.status).toBe(TaskStatus.WAITING_FOR_APPROVAL);

    const approved = engine.approve(task.id, true);
    expect(approved?.status).toBe(TaskStatus.QUEUED);
    expect(approved?.approval?.decision).toBe('APPROVED');

    const finished = await engine.run(task.id);
    expect(finished?.status).toBe(TaskStatus.COMPLETED);
  });

  it('cancels the task when approval is refused', async () => {
    const engine = engineWith([
      tool('writes', async () => ({ ok: true, summary: 'wrote' }), { mutating: true, permissions: [Permission.EXECUTE] }),
    ]);
    const task = engine.add({
      ...researchTask([makeStep('writes', 'Submit')]),
      approvalRequired: true,
      permissions: [Permission.READ, Permission.EXECUTE],
    });
    engine.enqueue(task.id);
    await engine.run(task.id);

    const refused = engine.approve(task.id, false);
    expect(refused?.status).toBe(TaskStatus.CANCELLED);
  });

  it('refuses a tool the task was not granted', async () => {
    const engine = engineWith([
      tool('files', async () => ({ ok: true, summary: 'read' }), { permissions: [Permission.FILES] }),
    ]);
    const task = engine.add(researchTask([makeStep('files', 'Read a folder')]));
    engine.enqueue(task.id);

    const finished = await engine.run(task.id);
    expect(finished?.status).toBe(TaskStatus.FAILED);
    expect(finished?.errors[0]?.message).toMatch(/permission/i);
  });

  it('fails clearly when a step names a tool that does not exist', async () => {
    const engine = engineWith([]);
    const task = engine.add(researchTask([makeStep('ghost', 'Nothing here')]));
    engine.enqueue(task.id);

    const finished = await engine.run(task.id);
    expect(finished?.status).toBe(TaskStatus.FAILED);
    expect(finished?.errors[0]?.message).toMatch(/No tool named/);
  });
});

describe('permissions', () => {
  it('reports exactly which grant is missing', () => {
    const t = tool('browser', async () => ({ ok: true, summary: '' }), { permissions: [Permission.BROWSER] });
    expect(() => assertPermitted(t as never, [Permission.READ])).toThrow(PermissionDeniedError);
    expect(() => assertPermitted(t as never, [Permission.BROWSER])).not.toThrow();
  });
});

describe('restart recovery', () => {
  it('keeps tasks across a restart and requeues anything that claimed to be running', async () => {
    const first = engineWith([tool('ok', async () => ({ ok: true, summary: 'done' }))]);
    const task = first.add(researchTask());
    first.enqueue(task.id);

    // A crash mid-run leaves a task marked RUNNING with no process behind it.
    first.save({ ...(first.get(task.id) as never), status: TaskStatus.RUNNING });

    // A brand new engine reads the same file, exactly as a restart would.
    const second = engineWith([tool('ok', async () => ({ ok: true, summary: 'done' }))]);
    const survived = second.get(task.id);
    expect(survived).toBeDefined();
    expect(survived?.name).toBe('Test task');

    const { requeued } = second.recoverOnStartup();
    expect(requeued).toBe(1);
    expect(second.get(task.id)?.status).toBe(TaskStatus.QUEUED);

    const finished = await second.run(task.id);
    expect(finished?.status).toBe(TaskStatus.COMPLETED);
  });

  it('leaves a task waiting on a human waiting after a restart', () => {
    const first = engineWith([]);
    const task = first.add(researchTask());
    first.save({ ...(first.get(task.id) as never), status: TaskStatus.WAITING_FOR_HUMAN });

    const second = engineWith([]);
    const { waiting } = second.recoverOnStartup();
    expect(waiting).toBe(1);
    expect(second.get(task.id)?.status).toBe(TaskStatus.WAITING_FOR_HUMAN);
  });
});

describe('finding tasks by description', () => {
  it('matches on a fragment of the name', () => {
    const engine = engineWith([]);
    const task = engine.add({ ...researchTask(), name: 'Job search' });
    engine.enqueue(task.id);
    expect(engine.findByDescription('job search')?.id).toBe(task.id);
    expect(engine.findByDescription('job')?.id).toBe(task.id);
    expect(engine.findByDescription('nothing like this')).toBeUndefined();
  });
});
