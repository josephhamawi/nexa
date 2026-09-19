import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import { WatcherType, type CreateWatcherInput, type Watcher } from '../watchers/Watcher';
import { childLogger } from '../logging/logger';

const log = childLogger('tool:watcher');

const InputSchema = z.object({
  operation: z.enum(['create', 'list', 'pause', 'resume', 'delete']).default('create'),
  name: z.string().default(''),
  target: z.string().default(''),
  type: z.nativeEnum(WatcherType).default(WatcherType.WEBSITE),
  selector: z.string().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  intervalSeconds: z.number().int().min(60).max(604_800).default(21_600),
  watcherId: z.string().default(''),
});

type Input = z.infer<typeof InputSchema>;

export interface WatcherToolDeps {
  create: (input: CreateWatcherInput) => Watcher;
  list: () => Watcher[];
  setStatus: (id: string, status: 'ACTIVE' | 'PAUSED') => Watcher | undefined;
  remove: (id: string) => boolean;
  minIntervalSeconds: () => number;
}

/**
 * Creates and manages watchers.
 *
 * The interval floor matters: a watcher is a request to someone else's server
 * every N seconds, forever. Anything under the configured minimum is raised
 * rather than accepted, so an over-eager instruction cannot turn Nexa into a
 * hammer.
 */
export class WatcherTool implements Tool<Input> {
  readonly name = 'watcher';
  readonly description =
    'Create or manage a watcher that checks a page or search on a schedule and reports meaningful changes. ' +
    'Input: {operation, name, target, type, keywords, intervalSeconds}.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.RESEARCH];
  readonly mutating = false;

  constructor(private readonly deps: WatcherToolDeps) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    switch (input.operation) {
      case 'create': {
        if (!input.target) {
          return { ok: false, summary: 'A watcher needs a target', error: 'missing target' };
        }

        const floor = this.deps.minIntervalSeconds();
        const interval = Math.max(floor, input.intervalSeconds);
        if (interval !== input.intervalSeconds) {
          context.report(`Interval raised to ${Math.round(interval / 60)} min to stay polite`);
        }

        const watcher = this.deps.create({
          name: input.name || `Watch ${shortTarget(input.target)}`,
          description: context.task.naturalLanguageRequest,
          type: input.type,
          target: input.target,
          selector: input.selector,
          keywords: input.keywords,
          intervalSeconds: interval,
          source: context.task.source === 'telegram' ? 'telegram' : 'desktop',
          sourceChatId: context.task.sourceChatId ?? null,
        });

        log.info({ watcher: watcher.id, target: shortTarget(watcher.target) }, 'watcher created');
        context.addEvidence({
          kind: 'note',
          title: watcher.name,
          url: watcher.target.startsWith('http') ? watcher.target : null,
          summary: `Watcher created, checking every ${Math.round(interval / 60)} min`,
        });

        return {
          ok: true,
          summary: `Watching ${shortTarget(watcher.target)} every ${Math.round(interval / 60)} min`,
          data: { watcher },
        };
      }

      case 'list': {
        const watchers = this.deps.list();
        return {
          ok: true,
          summary: `${watchers.length} watcher(s) configured`,
          data: { items: watchers.map(summarize) },
        };
      }

      case 'pause':
      case 'resume': {
        const status = input.operation === 'pause' ? 'PAUSED' : 'ACTIVE';
        const watcher = this.deps.setStatus(input.watcherId, status);
        if (!watcher) return { ok: false, summary: 'No watcher with that id', error: 'not found' };
        return { ok: true, summary: `${watcher.name} is now ${status.toLowerCase()}`, data: { watcher } };
      }

      case 'delete': {
        const removed = this.deps.remove(input.watcherId);
        return removed
          ? { ok: true, summary: 'Watcher deleted' }
          : { ok: false, summary: 'No watcher with that id', error: 'not found' };
      }

      default:
        return { ok: false, summary: 'Unknown watcher operation', error: 'bad operation' };
    }
  }
}

function summarize(watcher: Watcher): Record<string, unknown> {
  return {
    id: watcher.id,
    name: watcher.name,
    target: watcher.target,
    type: watcher.type,
    status: watcher.status,
    everyMinutes: Math.round(watcher.intervalSeconds / 60),
    lastChecked: watcher.lastChecked,
    lastChanged: watcher.lastChanged,
  };
}

export function shortTarget(target: string): string {
  try {
    return new URL(target).host;
  } catch {
    return target.slice(0, 60);
  }
}
