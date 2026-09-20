import { EventEmitter } from 'node:events';
import {
  AgentPhase,
  TaskStatus,
  computeNextRun,
  computeProgress,
  isTerminal,
  transition,
  type Evidence,
  type Task,
  type TaskStep,
} from './Task';
import { JsonStore } from '../storage/JsonStore';
import { assertPermitted, type ToolContext, type ToolRegistry, type ToolResult } from '../tools/Tool';
import type { EvidenceStore } from '../evidence/EvidenceStore';
import type { NotificationManager } from '../notifications/NotificationManager';
import type { ActivityLog } from '../agent/ActivityLog';
import { computeConfidence } from '../agent/Confidence';
import { paths } from '../config/config';
import { childLogger } from '../logging/logger';
import { sleep } from '../utils/time';

const log = childLogger('tasks');

export interface TaskEngineOptions {
  maxStepRetries: number;
  requireApprovalForWrites: boolean;
  /** Human activity window: scheduled work waits while you use the browser. */
  isBrowserBusy: () => boolean;
  /**
   * Lets the agent decide what to do next after seeing a step's result, rather
   * than following the plan blindly. Returns extra steps to append, or none.
   */
  reflect?: (task: Task) => Promise<TaskStep[]>;
  /** Ceiling on adaptively-added steps, so a loop cannot run away. */
  maxAdaptiveSteps?: number;
}

/**
 * Runs tasks step by step and owns their state.
 *
 * Every transition goes through `transition()`, every step result is persisted
 * before the next one starts, and a task that stops for a human keeps its
 * position. That is what makes work survive a restart instead of silently
 * vanishing.
 */
export class TaskEngine extends EventEmitter {
  private readonly store: JsonStore<Task>;
  private running: string | null = null;
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly tools: ToolRegistry,
    private readonly evidence: EvidenceStore,
    private readonly notifications: NotificationManager,
    private readonly activity: ActivityLog,
    private options: TaskEngineOptions,
  ) {
    super();
    this.store = new JsonStore<Task>(paths.tasksFile);
  }

  updateOptions(options: Partial<TaskEngineOptions>): void {
    this.options = { ...this.options, ...options };
  }

  // ------------------------------------------------------------------ access

  all(): Task[] {
    return this.store.all();
  }

  get(id: string): Task | undefined {
    return this.store.find(id);
  }

  active(): Task[] {
    return this.store.filter((task) => !isTerminal(task.status));
  }

  history(limit = 50): Task[] {
    return this.store
      .filter((task) => isTerminal(task.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit);
  }

  /** Loose match on name or id, for "pause the job search". */
  findByDescription(text: string): Task | undefined {
    const needle = text.trim().toLowerCase();
    if (!needle) return undefined;
    const candidates = this.store.filter((task) => !isTerminal(task.status));
    return (
      candidates.find((task) => task.id === needle) ??
      candidates.find((task) => task.name.toLowerCase() === needle) ??
      candidates.find((task) => task.name.toLowerCase().includes(needle)) ??
      candidates.find((task) => task.naturalLanguageRequest.toLowerCase().includes(needle))
    );
  }

  save(task: Task): Task {
    this.store.upsert(task);
    this.emit('task', task);
    return task;
  }

  add(task: Task): Task {
    this.store.insert(task);
    this.activity.add(`Task created: ${task.name}`, 'info', task.id);
    this.emit('task', task);
    return task;
  }

  // ------------------------------------------------------------- transitions

  enqueue(taskId: string): Task | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;
    const next = transition({ ...task, nextRun: task.nextRun ?? new Date().toISOString() }, TaskStatus.QUEUED);
    return this.save(next);
  }

  pause(taskId: string): Task | undefined {
    const task = this.get(taskId);
    if (!task || isTerminal(task.status)) return undefined;
    this.controllers.get(taskId)?.abort();
    const next = transition(task, TaskStatus.PAUSED);
    this.activity.add(`Task paused: ${task.name}`, 'warn', task.id);
    return this.save(next);
  }

  resume(taskId: string): Task | undefined {
    const task = this.get(taskId);
    if (!task) return undefined;
    if (task.status === TaskStatus.WAITING_FOR_HUMAN || task.status === TaskStatus.PAUSED) {
      const next = transition({ ...task, nextRun: new Date().toISOString() }, TaskStatus.QUEUED);
      this.activity.add(`Task resumed: ${task.name}`, 'info', task.id);
      return this.save(next);
    }
    return task;
  }

  cancel(taskId: string): Task | undefined {
    const task = this.get(taskId);
    if (!task || task.status === TaskStatus.CANCELLED) return task;
    this.controllers.get(taskId)?.abort();
    const next = transition(task, TaskStatus.CANCELLED);
    this.activity.add(`Task cancelled: ${task.name}`, 'warn', task.id);
    return this.save(next);
  }

  approve(taskId: string, approved: boolean): Task | undefined {
    const task = this.get(taskId);
    if (!task || task.status !== TaskStatus.WAITING_FOR_APPROVAL) return undefined;

    const decided = {
      ...task,
      approval: {
        requestedAt: task.approval?.requestedAt ?? new Date().toISOString(),
        reason: task.approval?.reason ?? '',
        decidedAt: new Date().toISOString(),
        decision: approved ? ('APPROVED' as const) : ('REJECTED' as const),
      },
    };

    if (!approved) {
      this.activity.add(`Approval refused: ${task.name}`, 'warn', task.id);
      return this.save(transition({ ...decided, result: 'Stopped: you did not approve this step.' }, TaskStatus.CANCELLED));
    }

    this.activity.add(`Approved: ${task.name}`, 'success', task.id);
    return this.save(transition({ ...decided, nextRun: new Date().toISOString() }, TaskStatus.QUEUED));
  }

  // --------------------------------------------------------------- execution

  /** Tasks that are due and ready to run, oldest scheduled first. */
  due(now = new Date()): Task[] {
    return this.store
      .filter(
        (task) =>
          task.status === TaskStatus.QUEUED &&
          (!task.nextRun || new Date(task.nextRun).getTime() <= now.getTime()),
      )
      .sort((a, b) => (a.nextRun ?? '').localeCompare(b.nextRun ?? ''));
  }

  get isBusy(): boolean {
    return this.running !== null;
  }

  /**
   * Runs one task to a stopping point: finished, failed, or waiting on a human.
   * Only one at a time, which keeps ordering obvious and sites unhammered.
   */
  async run(taskId: string): Promise<Task | undefined> {
    if (this.running) {
      log.debug({ taskId, running: this.running }, 'another task is running');
      return undefined;
    }

    let task = this.get(taskId);
    if (!task) return undefined;
    if (task.status !== TaskStatus.QUEUED) return task;

    this.running = taskId;
    const controller = new AbortController();
    this.controllers.set(taskId, controller);

    try {
      task = this.save(
        transition({ ...task, phase: AgentPhase.PLANNING, lastRun: new Date().toISOString() }, TaskStatus.RUNNING),
      );
      this.activity.add(`Running: ${task.name}`, 'info', task.id);

      for (let index = task.currentStepIndex; index < task.steps.length; index += 1) {
        if (controller.signal.aborted) {
          return this.get(taskId);
        }

        const current = this.get(taskId);
        if (!current || current.status !== TaskStatus.RUNNING) return current;
        task = current;

        const step = task.steps[index] as TaskStep;
        if (step.status === 'DONE' || step.status === 'SKIPPED') continue;

        const outcome = await this.runStep(task, index, controller.signal);
        task = outcome.task;

        if (outcome.stop) return task;
      }

      // Before finishing, let the agent look at what it got and decide whether
      // the job is actually done. Bounded, so it cannot loop forever.
      const extra = await this.reflect(task, controller.signal);
      if (extra.length > 0) {
        task = this.save({ ...task, steps: [...task.steps, ...extra] });
        for (let index = task.currentStepIndex; index < task.steps.length; index += 1) {
          if (controller.signal.aborted) return this.get(taskId);
          const current = this.get(taskId);
          if (!current || current.status !== TaskStatus.RUNNING) return current;
          task = current;
          const step = task.steps[index] as TaskStep;
          if (step.status === 'DONE' || step.status === 'SKIPPED') continue;
          const outcome = await this.runStep(task, index, controller.signal);
          task = outcome.task;
          if (outcome.stop) return task;
        }
      }

      return this.complete(task);
    } catch (err) {
      const message = (err as Error).message;
      log.error({ taskId, err: message }, 'task crashed');
      const current = this.get(taskId);
      if (!current) return undefined;
      return this.fail(current, message);
    } finally {
      this.controllers.delete(taskId);
      this.running = null;
    }
  }

  private async runStep(
    task: Task,
    index: number,
    signal: AbortSignal,
  ): Promise<{ task: Task; stop: boolean }> {
    const step = task.steps[index] as TaskStep;
    const tool = this.tools.get(step.tool);

    if (!tool) {
      return { task: this.fail(task, `No tool named "${step.tool}" is registered`), stop: true };
    }

    try {
      assertPermitted(tool, task.permissions);
    } catch (err) {
      return { task: this.fail(task, (err as Error).message), stop: true };
    }

    // A step that changes something outside Nexa asks first, once.
    if (
      tool.mutating &&
      this.options.requireApprovalForWrites &&
      task.approvalRequired &&
      task.approval?.decision !== 'APPROVED'
    ) {
      return { task: await this.requestApproval(task, index, tool.name), stop: true };
    }

    let parsedInput: unknown;
    try {
      parsedInput = tool.inputSchema.parse(step.input);
    } catch (err) {
      return { task: this.fail(task, `Step "${step.description}" has invalid input: ${(err as Error).message}`), stop: true };
    }

    const maxAttempts = this.options.maxStepRetries + 1;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal.aborted) return { task, stop: true };

      task = this.save({
        ...task,
        phase: phaseFor(tool.name),
        currentStepIndex: index,
        steps: replaceStep(task.steps, index, {
          ...step,
          status: 'RUNNING',
          attempts: attempt,
          startedAt: new Date().toISOString(),
        }),
      });

      const context = this.buildContext(task, step, signal);
      let result: ToolResult;

      try {
        result = await (tool.execute as (input: unknown, ctx: ToolContext) => Promise<ToolResult>)(parsedInput, context);
      } catch (err) {
        result = { ok: false, summary: `${tool.name} threw`, error: (err as Error).message };
      }

      // Re-read: the tool may have attached evidence through the context.
      task = this.get(task.id) ?? task;

      if (result.needsHuman) {
        return { task: await this.parkForHuman(task, index, result.needsHuman.reason), stop: true };
      }

      if (result.needsApproval) {
        return { task: await this.requestApproval(task, index, result.needsApproval.reason), stop: true };
      }

      if (result.ok) {
        this.activity.add(result.summary, 'info', task.id);
        const updated = {
          ...task,
          steps: replaceStep(task.steps, index, {
            ...(task.steps[index] as TaskStep),
            status: 'DONE' as const,
            finishedAt: new Date().toISOString(),
            output: result.data,
            error: null,
          }),
          currentStepIndex: index + 1,
        };
        return { task: this.save({ ...updated, progress: computeProgress(updated) }), stop: false };
      }

      lastError = result.error ?? result.summary;
      log.warn({ task: task.id, step: step.tool, attempt, err: lastError }, 'step failed');
      this.activity.add(`${result.summary} (attempt ${attempt}/${maxAttempts})`, 'warn', task.id);

      if (attempt < maxAttempts) {
        // Exponential backoff with a ceiling, so a flaky site is retried
        // without turning into a burst of requests.
        await sleep(Math.min(15_000, 1500 * 2 ** (attempt - 1)));
      }
    }

    const failedTask = {
      ...task,
      steps: replaceStep(task.steps, index, {
        ...(task.steps[index] as TaskStep),
        status: 'FAILED' as const,
        finishedAt: new Date().toISOString(),
        error: lastError,
      }),
    };
    return { task: this.fail(failedTask, lastError, step.description), stop: true };
  }

  /**
   * Asks the agent whether the plan needs extending.
   *
   * This is what makes Nexa adaptive rather than a script runner: a search that
   * came back thin can trigger another angle before the task is called done.
   * Strictly bounded, and never allowed to grow a task without limit.
   */
  private async reflect(task: Task, signal: AbortSignal): Promise<TaskStep[]> {
    if (!this.options.reflect || signal.aborted) return [];

    const ceiling = this.options.maxAdaptiveSteps ?? 3;
    const added = task.steps.length - task.plannedStepCount;
    if (added >= ceiling) {
      log.debug({ task: task.id }, 'adaptive step ceiling reached');
      return [];
    }

    try {
      const extra = await this.options.reflect(task);
      if (extra.length === 0) return [];
      const room = Math.max(0, ceiling - added);
      const allowed = extra.slice(0, room);
      if (allowed.length > 0) {
        this.activity.add(`Adjusting plan: ${allowed.map((step) => step.description).join('; ')}`, 'info', task.id);
      }
      return allowed;
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'reflection failed, finishing as planned');
      return [];
    }
  }

  private buildContext(task: Task, step: TaskStep, signal: AbortSignal): ToolContext {
    return {
      task,
      step,
      signal,
      report: (message: string) => {
        this.activity.add(message, 'info', task.id);
        this.emit('progress', { taskId: task.id, message });
      },
      addEvidence: (input) => {
        const evidence = this.evidence.build(task.id, step.id, input);
        this.store.update(task.id, (current) => ({ ...current, evidence: [...current.evidence, evidence] }));
        const updated = this.get(task.id);
        if (updated) this.emit('task', updated);
        return evidence;
      },
    };
  }

  private async parkForHuman(task: Task, index: number, reason: string): Promise<Task> {
    const parked = this.save(
      transition(
        {
          ...task,
          phase: AgentPhase.WAITING,
          currentStepIndex: index,
          steps: replaceStep(task.steps, index, { ...(task.steps[index] as TaskStep), status: 'PENDING' }),
        },
        TaskStatus.WAITING_FOR_HUMAN,
      ),
    );

    this.activity.add(`Waiting for you: ${reason}`, 'warn', task.id);
    await this.notifications.humanNeeded({
      taskName: task.name,
      reason,
      taskId: task.id,
      chatId: task.sourceChatId ?? null,
    });
    this.emit('needs-human', parked);
    return parked;
  }

  private async requestApproval(task: Task, index: number, reason: string): Promise<Task> {
    const waiting = this.save(
      transition(
        {
          ...task,
          phase: AgentPhase.WAITING,
          currentStepIndex: index,
          approval: { requestedAt: new Date().toISOString(), reason, decidedAt: null, decision: null },
        },
        TaskStatus.WAITING_FOR_APPROVAL,
      ),
    );

    this.activity.add(`Approval needed: ${reason}`, 'warn', task.id);
    await this.notifications.approvalNeeded({
      taskName: task.name,
      reason,
      taskId: task.id,
      chatId: task.sourceChatId ?? null,
    });
    this.emit('needs-approval', waiting);
    return waiting;
  }

  private complete(task: Task): Task {
    const summary = lastSummary(task);
    const nextRun = computeNextRun(task.recurrence);
    // Scored from what actually happened: sources read, how they were judged,
    // retries, failures and whether evidence exists to check.
    const confidence = computeConfidence(task);

    let finished = transition(
      { ...task, phase: AgentPhase.COMPLETED, progress: 100, result: summary, nextRun, confidence },
      TaskStatus.COMPLETED,
    );

    this.activity.add(
      `Completed: ${task.name} (${confidence.level === 'none' ? 'simulated' : `${confidence.score}% confidence`})`,
      confidence.level === 'low' ? 'warn' : 'success',
      task.id,
    );
    this.emit('completed', finished);

    // A recurring task goes straight back into the queue for its next run.
    if (nextRun) {
      finished = transition(
        {
          ...finished,
          currentStepIndex: 0,
          steps: finished.steps.map((step) => ({ ...step, status: 'PENDING' as const, output: undefined, error: null })),
          progress: 0,
        },
        TaskStatus.QUEUED,
      );
      this.activity.add(`Next run ${new Date(nextRun).toLocaleString()}`, 'info', task.id);
    }

    return this.save(finished);
  }

  private fail(task: Task, message: string, step?: string): Task {
    const failed = this.save(
      transition(
        {
          ...task,
          phase: AgentPhase.FAILED,
          result: `Failed: ${message}`,
          errors: [...task.errors, { at: new Date().toISOString(), message, step }],
          // A recurring task still gets another go later.
          nextRun: computeNextRun(task.recurrence),
        },
        TaskStatus.FAILED,
      ),
    );

    this.activity.add(`Failed: ${task.name} - ${message}`, 'error', task.id);
    void this.notifications.taskFailed({
      taskName: task.name,
      error: message,
      chatId: task.sourceChatId ?? null,
    });
    this.emit('failed', failed);
    return failed;
  }

  /**
   * Brings state back to something sane after a restart.
   *
   * Anything that claims to be RUNNING cannot be: the process that ran it is
   * gone. Those go back in the queue rather than sitting there forever.
   */
  recoverOnStartup(): { requeued: number; waiting: number } {
    let requeued = 0;
    let waiting = 0;

    for (const task of this.store.all()) {
      if (task.status === TaskStatus.RUNNING) {
        this.save(transition({ ...task, phase: AgentPhase.THINKING }, TaskStatus.QUEUED));
        requeued += 1;
      } else if (task.status === TaskStatus.WAITING_FOR_HUMAN || task.status === TaskStatus.WAITING_FOR_APPROVAL) {
        waiting += 1;
      } else if (task.status === TaskStatus.COMPLETED && task.nextRun) {
        // A recurring task whose next slot came round while Nexa was closed.
        this.save(transition(task, TaskStatus.QUEUED));
        requeued += 1;
      }
    }

    if (requeued > 0 || waiting > 0) {
      log.info({ requeued, waiting }, 'restored tasks after restart');
    }
    return { requeued, waiting };
  }

  pruneHistory(keep = 200): void {
    this.store.prune(keep, (task) => task.createdAt);
  }
}

function replaceStep(steps: TaskStep[], index: number, step: TaskStep): TaskStep[] {
  const next = [...steps];
  next[index] = step;
  return next;
}

function lastSummary(task: Task): string {
  for (const step of [...task.steps].reverse()) {
    if (step.status !== 'DONE') continue;
    const output = step.output as { report?: string; summary?: string } | undefined;
    if (output?.report) return String(output.report).slice(0, 2000);
  }
  return `${task.steps.filter((s) => s.status === 'DONE').length} step(s) completed`;
}

function phaseFor(toolName: string): AgentPhase {
  switch (toolName) {
    case 'web_research':
      return AgentPhase.RESEARCHING;
    case 'browser':
      return AgentPhase.BROWSING;
    case 'analyze':
      return AgentPhase.ANALYZING;
    case 'files':
      return AgentPhase.EXTRACTING;
    case 'notify':
      return AgentPhase.EXECUTING;
    default:
      return AgentPhase.EXECUTING;
  }
}

export type { Evidence };
