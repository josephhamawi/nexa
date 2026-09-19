import { describe, expect, it } from 'vitest';
import {
  TaskStatus,
  canTransition,
  computeNextRun,
  computeProgress,
  createTask,
  describeRecurrence,
  isActive,
  isTerminal,
  isWaitingOnHuman,
  makeStep,
  transition,
  InvalidTransitionError,
  TaskType,
} from '../src/tasks/Task';

function sample() {
  return createTask({
    name: 'Research AI agents',
    naturalLanguageRequest: 'research the latest AI agent frameworks',
    type: TaskType.RESEARCH,
    steps: [makeStep('web_research', 'Search'), makeStep('analyze', 'Rank'), makeStep('notify', 'Report')],
  });
}

describe('task creation', () => {
  it('starts as a draft with nothing done', () => {
    const task = sample();
    expect(task.status).toBe(TaskStatus.DRAFT);
    expect(task.progress).toBe(0);
    expect(task.currentStepIndex).toBe(0);
    expect(task.steps.every((step) => step.status === 'PENDING')).toBe(true);
    expect(task.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('state machine', () => {
  it('allows the normal path', () => {
    let task = sample();
    task = transition(task, TaskStatus.QUEUED);
    task = transition(task, TaskStatus.RUNNING);
    task = transition(task, TaskStatus.COMPLETED);
    expect(task.status).toBe(TaskStatus.COMPLETED);
  });

  it('allows pausing for a human and coming back', () => {
    let task = transition(transition(sample(), TaskStatus.QUEUED), TaskStatus.RUNNING);
    task = transition(task, TaskStatus.WAITING_FOR_HUMAN);
    expect(isWaitingOnHuman(task.status)).toBe(true);
    task = transition(task, TaskStatus.QUEUED);
    expect(task.status).toBe(TaskStatus.QUEUED);
  });

  it('refuses impossible jumps', () => {
    const task = sample();
    expect(canTransition(TaskStatus.DRAFT, TaskStatus.RUNNING)).toBe(false);
    expect(() => transition(task, TaskStatus.RUNNING)).toThrow(InvalidTransitionError);
    expect(canTransition(TaskStatus.CANCELLED, TaskStatus.QUEUED)).toBe(false);
  });

  it('lets a completed recurring task queue again but never a cancelled one', () => {
    expect(canTransition(TaskStatus.COMPLETED, TaskStatus.QUEUED)).toBe(true);
    expect(canTransition(TaskStatus.CANCELLED, TaskStatus.RUNNING)).toBe(false);
  });

  it('classifies statuses', () => {
    expect(isTerminal(TaskStatus.COMPLETED)).toBe(true);
    expect(isTerminal(TaskStatus.RUNNING)).toBe(false);
    expect(isActive(TaskStatus.WAITING_FOR_APPROVAL)).toBe(true);
    expect(isActive(TaskStatus.FAILED)).toBe(false);
  });
});

describe('progress', () => {
  it('counts finished steps', () => {
    const task = sample();
    expect(computeProgress(task)).toBe(0);
    task.steps[0].status = 'DONE';
    expect(computeProgress(task)).toBe(33);
    task.steps[1].status = 'DONE';
    task.steps[2].status = 'SKIPPED';
    expect(computeProgress(task)).toBe(100);
  });
});

describe('recurrence', () => {
  const from = new Date('2026-03-10T09:30:00');

  it('a one-off has no next run', () => {
    expect(computeNextRun({ kind: 'once' }, from)).toBeNull();
  });

  it('intervals are never shorter than a minute', () => {
    const next = computeNextRun({ kind: 'interval', everySeconds: 10 }, from);
    expect(new Date(next as string).getTime() - from.getTime()).toBe(60_000);
  });

  it('daily rolls to tomorrow once the time has passed', () => {
    const next = new Date(computeNextRun({ kind: 'daily', at: '08:00' }, from) as string);
    expect(next.getDate()).toBe(11);
    expect(next.getHours()).toBe(8);
  });

  it('daily stays today when the time is still ahead', () => {
    const next = new Date(computeNextRun({ kind: 'daily', at: '18:00' }, from) as string);
    expect(next.getDate()).toBe(10);
    expect(next.getHours()).toBe(18);
  });

  it('weekly lands on the right weekday', () => {
    const next = new Date(computeNextRun({ kind: 'weekly', weekday: 5, at: '09:00' }, from) as string);
    expect(next.getDay()).toBe(5);
  });

  it('describes itself for humans', () => {
    expect(describeRecurrence({ kind: 'daily', at: '08:00' })).toBe('daily at 08:00');
    expect(describeRecurrence({ kind: 'interval', everySeconds: 7200 })).toBe('every 2h');
    expect(describeRecurrence({ kind: 'once' })).toBe('once');
  });
});
