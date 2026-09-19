import { z } from 'zod';
import type { Evidence, Permission, Task, TaskStep } from '../tasks/Task';

/**
 * Every capability Nexa has is a Tool behind this one interface.
 *
 * The permission list is the security boundary: the task engine checks a
 * tool's requirements against the task's grant before execution, so the model
 * choosing a tool can never widen what that task is allowed to touch.
 */
export interface ToolContext {
  task: Task;
  step: TaskStep;
  /** Report a user-facing phase or progress line. No internal reasoning. */
  report: (message: string) => void;
  /** Attach proof of what happened. */
  addEvidence: (evidence: Omit<Evidence, 'id' | 'taskId' | 'at' | 'stepId'>) => Evidence;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Short line for the activity log and Telegram. */
  summary: string;
  /** Structured payload passed to later steps. */
  data?: unknown;
  /** Stop and ask a human; the task parks in WAITING_FOR_HUMAN. */
  needsHuman?: { reason: string; url?: string | null };
  /** Ask for a yes before continuing; parks in WAITING_FOR_APPROVAL. */
  needsApproval?: { reason: string };
  error?: string;
}

export interface Tool<TInput = Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  /**
   * Validates and defaults the step input before execution. The third type
   * parameter is `unknown` because a schema with defaults accepts less than it
   * produces, which is exactly what we want at this boundary.
   */
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  readonly permissions: Permission[];
  /** True when the tool changes something outside Nexa. */
  readonly mutating: boolean;
  execute(input: TInput, context: ToolContext): Promise<ToolResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<never>>();

  register<T>(tool: Tool<T>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool as unknown as Tool<never>);
  }

  get(name: string): Tool<never> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool<never>[] {
    return [...this.tools.values()];
  }

  /** Compact catalogue handed to the planner so it knows what exists. */
  describeForPlanner(): string {
    return this.list()
      .map((tool) => `- ${tool.name}: ${tool.description}`)
      .join('\n');
  }
}

export class PermissionDeniedError extends Error {
  constructor(tool: string, missing: Permission[]) {
    super(`Tool "${tool}" needs permission(s) ${missing.join(', ')}, which this task was not given`);
    this.name = 'PermissionDeniedError';
  }
}

export function assertPermitted(tool: Tool<never>, granted: Permission[]): void {
  const missing = tool.permissions.filter((needed) => !granted.includes(needed));
  if (missing.length > 0) throw new PermissionDeniedError(tool.name, missing);
}
