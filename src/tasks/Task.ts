import { randomUUID } from 'node:crypto';

/**
 * A unit of work Nexa owns end to end.
 *
 * Status is a real state machine rather than a scatter of booleans: every
 * transition is declared in ALLOWED_TRANSITIONS below and checked at runtime,
 * so a task can never be, say, both RUNNING and CANCELLED.
 */
export const TaskStatus = {
  DRAFT: 'DRAFT',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  WAITING_FOR_HUMAN: 'WAITING_FOR_HUMAN',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  PAUSED: 'PAUSED',
  CANCELLED: 'CANCELLED',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskType = {
  RESEARCH: 'RESEARCH',
  BROWSER_WORKFLOW: 'BROWSER_WORKFLOW',
  WATCH: 'WATCH',
  FILE_ANALYSIS: 'FILE_ANALYSIS',
  REPORT: 'REPORT',
  CONTROL: 'CONTROL',
} as const;

export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/** Coarse phases surfaced to the user. Never internal reasoning. */
export const AgentPhase = {
  THINKING: 'THINKING',
  PLANNING: 'PLANNING',
  RESEARCHING: 'RESEARCHING',
  BROWSING: 'BROWSING',
  EXTRACTING: 'EXTRACTING',
  ANALYZING: 'ANALYZING',
  WAITING: 'WAITING',
  EXECUTING: 'EXECUTING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

export type AgentPhase = (typeof AgentPhase)[keyof typeof AgentPhase];

/** What a task is permitted to do. A step outside its grant is refused. */
export const Permission = {
  READ: 'READ',
  RESEARCH: 'RESEARCH',
  BROWSER: 'BROWSER',
  FILES: 'FILES',
  EXECUTE: 'EXECUTE',
  NOTIFY: 'NOTIFY',
  /** Writes to the user's calendar. Separate from EXECUTE so a task that may
   *  run a browser workflow cannot also book things. */
  CALENDAR: 'CALENDAR',
  /** Writes to the user's notes. */
  NOTES: 'NOTES',
  /** Composes mail as the user. The narrowest grant Nexa hands out. */
  MAIL: 'MAIL',
  /** Reads the user's inbox. Separate from MAIL so a task allowed to draft a
   *  reply is not thereby allowed to read everything that ever arrived. */
  MAIL_READ: 'MAIL_READ',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export interface Recurrence {
  kind: 'once' | 'interval' | 'daily' | 'weekly';
  /** interval only, in seconds. */
  everySeconds?: number;
  /** daily and weekly, local HH:mm. */
  at?: string;
  /** weekly only: 0 = Sunday. */
  weekday?: number;
}

export interface TaskStep {
  id: string;
  tool: string;
  /** Shown to the user, e.g. "Search 8 sources for remote AI roles". */
  description: string;
  input: Record<string, unknown>;
  status: 'PENDING' | 'RUNNING' | 'DONE' | 'SKIPPED' | 'FAILED';
  startedAt?: string | null;
  finishedAt?: string | null;
  output?: unknown;
  /**
   * The tool's own one-line account of what happened.
   *
   * Kept because the data alone loses the context: an empty result reads as a
   * bug, while "No mail today in joseph@..." is an answer. Later steps and the
   * result dialog both read this.
   */
  summary?: string | null;
  error?: string | null;
  attempts: number;
}

export interface Evidence {
  id: string;
  taskId: string;
  stepId: string | null;
  at: string;
  kind: 'screenshot' | 'page' | 'data' | 'file' | 'note';
  url?: string | null;
  title?: string | null;
  /** Absolute path for screenshots and captured payloads. */
  path?: string | null;
  summary?: string | null;
}

export interface Task {
  id: string;
  name: string;
  description: string;
  /** Exactly what the user asked for, kept verbatim for auditing. */
  naturalLanguageRequest: string;
  type: TaskType;
  status: TaskStatus;
  phase: AgentPhase;
  createdAt: string;
  updatedAt: string;
  scheduledAt: string | null;
  nextRun: string | null;
  lastRun: string | null;
  recurrence: Recurrence;
  permissions: Permission[];
  tools: string[];
  steps: TaskStep[];
  /** How many steps the original plan had, so adaptive additions are visible. */
  plannedStepCount: number;
  currentStepIndex: number;
  /** 0-100, derived from completed steps. */
  progress: number;
  result: string | null;
  resultData?: unknown;
  /** How much the finished result deserves to be trusted, with reasons. */
  confidence?: { score: number; level: string; summary: string; factors: { label: string; delta: number }[] } | null;
  evidence: Evidence[];
  errors: { at: string; message: string; step?: string }[];
  approvalRequired: boolean;
  approval?: {
    requestedAt: string;
    reason: string;
    decidedAt?: string | null;
    decision?: 'APPROVED' | 'REJECTED' | null;
  } | null;
  /** Set when a task is the execution arm of a watcher. */
  watcherId?: string | null;
  owner: string;
  /** Where the request came from, so replies go back the same way. */
  source: 'telegram' | 'desktop' | 'schedule' | 'system';
  sourceChatId?: string | null;
}

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  DRAFT: ['QUEUED', 'WAITING_FOR_APPROVAL', 'CANCELLED'],
  QUEUED: ['RUNNING', 'PAUSED', 'CANCELLED'],
  RUNNING: [
    'COMPLETED',
    'FAILED',
    'WAITING_FOR_APPROVAL',
    'WAITING_FOR_HUMAN',
    'PAUSED',
    'CANCELLED',
    // Crash recovery: a task still marked RUNNING at startup has no process
    // behind it, so it goes back in the queue rather than sitting there.
    'QUEUED',
  ],
  WAITING_FOR_APPROVAL: ['RUNNING', 'QUEUED', 'CANCELLED', 'FAILED'],
  WAITING_FOR_HUMAN: ['RUNNING', 'QUEUED', 'CANCELLED', 'FAILED', 'PAUSED'],
  // A recurring task goes round again, so a finished run is not the end.
  COMPLETED: ['QUEUED', 'CANCELLED'],
  FAILED: ['QUEUED', 'CANCELLED'],
  PAUSED: ['QUEUED', 'RUNNING', 'CANCELLED'],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(from: TaskStatus, to: TaskStatus) {
    super(`A task cannot go from ${from} to ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

/** The only place a task's status changes. Throws rather than corrupt state. */
export function transition(task: Task, to: TaskStatus): Task {
  if (!canTransition(task.status, to)) throw new InvalidTransitionError(task.status, to);
  return { ...task, status: to, updatedAt: new Date().toISOString() };
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

export function isWaitingOnHuman(status: TaskStatus): boolean {
  return status === 'WAITING_FOR_APPROVAL' || status === 'WAITING_FOR_HUMAN';
}

export function isActive(status: TaskStatus): boolean {
  return status === 'QUEUED' || status === 'RUNNING' || isWaitingOnHuman(status);
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  naturalLanguageRequest: string;
  type: TaskType;
  steps?: TaskStep[];
  permissions?: Permission[];
  tools?: string[];
  recurrence?: Recurrence;
  approvalRequired?: boolean;
  scheduledAt?: string | null;
  watcherId?: string | null;
  source?: Task['source'];
  sourceChatId?: string | null;
}

export function createTask(input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const recurrence: Recurrence = input.recurrence ?? { kind: 'once' };
  return {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? '',
    naturalLanguageRequest: input.naturalLanguageRequest,
    type: input.type,
    status: TaskStatus.DRAFT,
    phase: AgentPhase.THINKING,
    createdAt: now,
    updatedAt: now,
    scheduledAt: input.scheduledAt ?? null,
    nextRun: input.scheduledAt ?? null,
    lastRun: null,
    recurrence,
    permissions: input.permissions ?? [Permission.READ],
    tools: input.tools ?? [],
    steps: input.steps ?? [],
    plannedStepCount: (input.steps ?? []).length,
    currentStepIndex: 0,
    progress: 0,
    result: null,
    confidence: null,
    evidence: [],
    errors: [],
    approvalRequired: input.approvalRequired ?? false,
    approval: null,
    watcherId: input.watcherId ?? null,
    owner: 'local',
    source: input.source ?? 'desktop',
    sourceChatId: input.sourceChatId ?? null,
  };
}

export function makeStep(
  tool: string,
  description: string,
  input: Record<string, unknown> = {},
): TaskStep {
  return {
    id: randomUUID(),
    tool,
    description,
    input,
    status: 'PENDING',
    attempts: 0,
    error: null,
  };
}

export function computeProgress(task: Task): number {
  if (task.steps.length === 0) return task.status === 'COMPLETED' ? 100 : 0;
  const done = task.steps.filter((s) => s.status === 'DONE' || s.status === 'SKIPPED').length;
  return Math.round((done / task.steps.length) * 100);
}

/** Next run for a recurring task, or null when it is finished for good. */
export function computeNextRun(recurrence: Recurrence, from: Date = new Date()): string | null {
  const next = new Date(from.getTime());

  switch (recurrence.kind) {
    case 'once':
      return null;

    case 'interval': {
      const seconds = Math.max(60, recurrence.everySeconds ?? 3600);
      next.setSeconds(next.getSeconds() + seconds);
      return next.toISOString();
    }

    case 'daily': {
      const [hours, minutes] = parseTimeOfDay(recurrence.at ?? '08:00');
      next.setHours(hours, minutes, 0, 0);
      if (next <= from) next.setDate(next.getDate() + 1);
      return next.toISOString();
    }

    case 'weekly': {
      const [hours, minutes] = parseTimeOfDay(recurrence.at ?? '08:00');
      const weekday = recurrence.weekday ?? 1;
      next.setHours(hours, minutes, 0, 0);
      let delta = (weekday - next.getDay() + 7) % 7;
      if (delta === 0 && next <= from) delta = 7;
      next.setDate(next.getDate() + delta);
      return next.toISOString();
    }

    default:
      return null;
  }
}

function parseTimeOfDay(value: string): [number, number] {
  const match = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) return [8, 0];
  return [Number(match[1]), Number(match[2])];
}

export function describeRecurrence(recurrence: Recurrence): string {
  switch (recurrence.kind) {
    case 'once':
      return 'once';
    case 'interval': {
      const seconds = recurrence.everySeconds ?? 3600;
      if (seconds % 3600 === 0) return `every ${seconds / 3600}h`;
      return `every ${Math.round(seconds / 60)}m`;
    }
    case 'daily':
      return `daily at ${recurrence.at ?? '08:00'}`;
    case 'weekly': {
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      return `every ${days[recurrence.weekday ?? 1]} at ${recurrence.at ?? '08:00'}`;
    }
    default:
      return 'once';
  }
}
