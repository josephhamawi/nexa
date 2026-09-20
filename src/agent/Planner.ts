import { extractJson, type LlmProvider } from '../llm/LLMProvider';
import { Permission, TaskType, makeStep, type Recurrence, type TaskStep } from '../tasks/Task';
import type { ToolRegistry } from '../tools/Tool';
import type { UserProfile } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('planner');

export interface Plan {
  name: string;
  description: string;
  type: TaskType;
  steps: TaskStep[];
  permissions: Permission[];
  recurrence: Recurrence;
  approvalRequired: boolean;
  /** How the plan was produced, surfaced so the user knows what they got. */
  method: 'model' | 'rules';
  /** Set when the request is about Nexa itself rather than outside work. */
  control?: ControlIntent;
  /** Set when nothing Nexa has can do what was asked. */
  unsupported?: UnsupportedIntent;
}

/**
 * A request Nexa has no tool for.
 *
 * Without this, an action it cannot perform ("add a meeting to my calendar")
 * falls through to the research fallback and comes back as a web search marked
 * COMPLETED, which is worse than useless: it looks like success.
 */
export interface UnsupportedIntent {
  capability: string;
  /** What the user actually asked for, echoed back. */
  request: string;
}

export interface ControlIntent {
  action: 'list_tasks' | 'list_watchers' | 'pause' | 'resume' | 'cancel' | 'status' | 'help' | 'stop_all';
  /** Free text naming the target task or watcher, if one was mentioned. */
  target?: string;
}

export interface PlanContext {
  profile: UserProfile;
  tools: ToolRegistry;
  defaultWatchIntervalSeconds: number;
}

/**
 * Turns a sentence into an executable plan.
 *
 * Two paths on purpose. With a model configured the planner is flexible and
 * handles phrasing it has never seen. Without one it falls back to rules,
 * which cover the common shapes (watch this, research that, do it daily) so
 * Nexa is still genuinely useful before you add an API key.
 */
export class Planner {
  constructor(private readonly llm: LlmProvider) {}

  /** Commands about Nexa itself, recognised before any planning happens. */
  detectControl(text: string): ControlIntent | null {
    const normalized = text.trim().toLowerCase().replace(/^\//, '');

    if (/^(help|start)\b/.test(normalized)) return { action: 'help' };
    if (/^status\b/.test(normalized) || /how are things|what'?s going on/.test(normalized)) {
      return { action: 'status' };
    }
    if (/^(tasks|task)\b/.test(normalized) || /(show|list|what).{0,20}(tasks|running|active)/.test(normalized)) {
      return { action: 'list_tasks' };
    }
    if (/^(watches|watchers|watch list)\b/.test(normalized) || /(show|list).{0,20}watch/.test(normalized)) {
      return { action: 'list_watchers' };
    }
    if (/^stop everything|stop all|cancel everything/.test(normalized)) return { action: 'stop_all' };

    const pause = normalized.match(/^(?:pause|hold)\s+(?:the\s+)?(.+)$/) ?? normalized.match(/^pause$/);
    if (pause) return { action: 'pause', target: pause[1]?.trim() };

    const resume = normalized.match(/^(?:resume|continue|unpause)\s+(?:the\s+)?(.+)$/) ?? normalized.match(/^resume$/);
    if (resume) return { action: 'resume', target: resume[1]?.trim() };

    const cancel = normalized.match(/^(?:cancel|delete|remove|stop)\s+(?:the\s+)?(.+)$/);
    if (cancel) return { action: 'cancel', target: cancel[1]?.trim() };

    return null;
  }

  /**
   * Actions Nexa has no tool for.
   *
   * Only fires on imperatives: "research how to buy a domain" is a research
   * question and stays one, while "buy a domain" is an action Nexa cannot take.
   */
  detectUnsupported(text: string): UnsupportedIntent | null {
    const lower = text.trim().toLowerCase();

    // An explicit research framing wins: the user wants information, not action.
    if (/^(research|find out|look up|compare|summari[sz]e|what|which|who|when|where|why|how)\b/.test(lower)) {
      return null;
    }
    if (/\b(research|find me|search for|look up|tell me about)\b/.test(lower)) return null;

    const capabilities: { pattern: RegExp; capability: string }[] = [
      { pattern: /\b(add|put|create|schedule|book)\b[^.]{0,40}\b(calendar|meeting|event|appointment|reminder)\b/, capability: 'calendar' },
      { pattern: /\b(calendar|reminder)\b[^.]{0,30}\b(add|create|set)\b/, capability: 'calendar' },
      { pattern: /\bsend\b[^.]{0,30}\b(email|mail|message|text|whatsapp|sms|dm)\b/, capability: 'messaging' },
      { pattern: /\b(email|message|text|whatsapp|call|ring|phone)\s+(him|her|them|someone|[a-z]+@)/, capability: 'messaging' },
      { pattern: /\b(buy|purchase|order|pay for|subscribe to|book a (flight|hotel|table|room|ticket))\b/, capability: 'purchasing' },
      { pattern: /\bpost\b[^.]{0,30}\b(twitter|x|linkedin|instagram|facebook|reddit|tiktok)\b/, capability: 'social posting' },
      { pattern: /\b(apply|submit)\b[^.]{0,30}\b(application|form|job|cv|resume)\b/, capability: 'form submission' },
      { pattern: /\b(delete|remove|rename|move|write|edit|save)\b[^.]{0,20}\b(file|folder|document)\b/, capability: 'writing files' },
    ];

    for (const { pattern, capability } of capabilities) {
      if (pattern.test(lower)) return { capability, request: text.trim() };
    }
    return null;
  }

  async plan(request: string, context: PlanContext): Promise<Plan> {
    const control = this.detectControl(request);
    if (control) {
      return {
        name: 'Control request',
        description: request,
        type: TaskType.CONTROL,
        steps: [],
        permissions: [Permission.READ],
        recurrence: { kind: 'once' },
        approvalRequired: false,
        method: 'rules',
        control,
      };
    }

    const unsupported = this.detectUnsupported(request);
    if (unsupported) {
      return {
        name: 'Unsupported request',
        description: request,
        type: TaskType.CONTROL,
        steps: [],
        permissions: [Permission.READ],
        recurrence: { kind: 'once' },
        approvalRequired: false,
        method: 'rules',
        unsupported,
      };
    }

    if (this.llm.available) {
      try {
        const plan = await this.planWithModel(request, context);
        if (plan) return plan;
        log.warn('model returned an unusable plan, falling back to rules');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'model planning failed, falling back to rules');
      }
    }

    return this.planWithRules(request, context);
  }

  private async planWithModel(request: string, context: PlanContext): Promise<Plan | null> {
    const result = await this.llm.complete({
      json: true,
      maxOutputTokens: 1600,
      messages: [
        {
          role: 'system',
          content: [
            'You plan tasks for Nexa, a local operations agent. Convert the request into a JSON plan.',
            '',
            'Available tools:',
            context.tools.describeForPlanner(),
            '',
            'Reply with JSON only, in this shape:',
            '{"name":"short title","description":"one line",',
            ' "type":"RESEARCH|BROWSER_WORKFLOW|WATCH|FILE_ANALYSIS|REPORT",',
            ' "recurrence":{"kind":"once|interval|daily|weekly","everySeconds":3600,"at":"08:00","weekday":1},',
            ' "approvalRequired":false,',
            ' "steps":[{"tool":"web_research","description":"what this step does","input":{}}]}',
            '',
            'Rules:',
            '- Use only the listed tools.',
            '- A task that reports back should finish with a "notify" step.',
            '- Research tasks are usually: web_research, then analyze, then notify.',
            '- A request to keep an eye on something is type WATCH with a single "watcher" step.',
            '- Set approvalRequired true only if a step would submit data, buy, post or change something.',
            '- Never invent tools or URLs. If no URL was given, do not fabricate one.',
          ].join('\n'),
        },
        {
          role: 'user',
          content:
            `Request: ${request}\n\n` +
            `User profile (use it when the request is about their career or interests):\n` +
            JSON.stringify(
              {
                summary: context.profile.summary,
                skills: context.profile.skills,
                preferredRoles: context.profile.preferredRoles,
                remotePreference: context.profile.remotePreference,
                salaryMin: context.profile.salaryMin,
              },
              null,
              2,
            ),
        },
      ],
    });

    const parsed = extractJson<{
      name?: string;
      description?: string;
      type?: string;
      recurrence?: Recurrence;
      approvalRequired?: boolean;
      steps?: { tool: string; description?: string; input?: Record<string, unknown> }[];
    }>(result.text);

    if (!parsed?.steps || parsed.steps.length === 0) return null;

    const steps = parsed.steps
      .filter((step) => context.tools.has(step.tool))
      .map((step) => makeStep(step.tool, step.description ?? step.tool, step.input ?? {}));

    if (steps.length === 0) return null;

    const type = isTaskType(parsed.type) ? parsed.type : TaskType.RESEARCH;

    return {
      name: (parsed.name ?? 'Task').slice(0, 80),
      description: (parsed.description ?? request).slice(0, 300),
      type,
      steps,
      permissions: permissionsFor(steps, context.tools),
      recurrence: normalizeRecurrence(parsed.recurrence),
      approvalRequired: Boolean(parsed.approvalRequired),
      method: 'model',
    };
  }

  /**
   * Rule-based planning.
   *
   * Deliberately conservative: it recognises a handful of clear shapes and
   * builds a sane plan for them, rather than guessing wildly at everything.
   */
  private planWithRules(request: string, context: PlanContext): Plan {
    const text = request.trim();
    const lower = text.toLowerCase();
    const url = extractUrl(text);
    const recurrence = parseRecurrence(lower);

    const wantsWatch = /\b(watch|monitor|keep an eye|notify me when|tell me when|alert me when|let me know when)\b/.test(lower);
    const wantsJobs = /\b(job|jobs|role|roles|position|vacanc|hiring|opening)\b/.test(lower);
    const wantsBrowser = /\b(log ?in|sign ?in|click|fill|submit|navigate through|go through)\b/.test(lower);

    if (wantsWatch && url) {
      const keywords = extractKeywords(text);
      const interval =
        recurrence.kind === 'interval' ? (recurrence.everySeconds ?? context.defaultWatchIntervalSeconds) : context.defaultWatchIntervalSeconds;

      return {
        name: `Watch ${hostOf(url)}`,
        description: text.slice(0, 300),
        type: TaskType.WATCH,
        steps: [
          makeStep('watcher', `Watch ${hostOf(url)} for changes`, {
            operation: 'create',
            target: url,
            type: wantsJobs ? 'JOB_SEARCH' : 'WEBSITE',
            keywords,
            intervalSeconds: interval,
            name: `Watch ${hostOf(url)}`,
          }),
        ],
        permissions: [Permission.RESEARCH],
        recurrence: { kind: 'once' },
        approvalRequired: false,
        method: 'rules',
      };
    }

    if (wantsBrowser && url) {
      return {
        name: `Browser workflow on ${hostOf(url)}`,
        description: text.slice(0, 300),
        type: TaskType.BROWSER_WORKFLOW,
        steps: [
          makeStep('browser', `Open ${hostOf(url)} and collect the page`, {
            steps: [
              { action: 'goto', url },
              { action: 'wait', seconds: 2 },
              { action: 'extract', selector: 'body', label: 'page' },
              { action: 'screenshot', label: 'result' },
            ],
          }),
          makeStep('analyze', 'Pull out what matters', { instruction: text, limit: 10 }),
          makeStep('notify', 'Send the result', { instruction: text, title: `Nexa: ${hostOf(url)}` }),
        ],
        permissions: [Permission.BROWSER, Permission.READ, Permission.NOTIFY],
        recurrence,
        approvalRequired: true,
        method: 'rules',
      };
    }

    if (wantsJobs) {
      const query = buildJobQuery(text, context.profile);
      return {
        name: 'Job search',
        description: text.slice(0, 300),
        type: TaskType.RESEARCH,
        steps: [
          makeStep('web_research', `Search for roles: ${query}`, { query, depth: 5 }),
          makeStep('analyze', 'Rank against your profile', {
            instruction: text,
            limit: extractCount(text) ?? 5,
            useProfile: true,
          }),
          makeStep('notify', 'Send the shortlist', { instruction: text, title: 'Nexa: job shortlist' }),
        ],
        permissions: [Permission.RESEARCH, Permission.READ, Permission.NOTIFY],
        recurrence,
        approvalRequired: false,
        method: 'rules',
      };
    }

    if (url) {
      return {
        name: `Read ${hostOf(url)}`,
        description: text.slice(0, 300),
        type: TaskType.BROWSER_WORKFLOW,
        steps: [
          makeStep('browser', `Open ${hostOf(url)}`, {
            steps: [
              { action: 'goto', url },
              { action: 'wait', seconds: 2 },
              { action: 'extract', selector: 'body', label: 'page' },
            ],
          }),
          makeStep('analyze', 'Summarise the page', { instruction: text, limit: 10 }),
          makeStep('notify', 'Send the summary', { instruction: text, title: `Nexa: ${hostOf(url)}` }),
        ],
        permissions: [Permission.BROWSER, Permission.READ, Permission.NOTIFY],
        recurrence,
        approvalRequired: false,
        method: 'rules',
      };
    }

    // Everything else is treated as a research question.
    const query = stripCommandWords(text);
    return {
      name: truncateTitle(query),
      description: text.slice(0, 300),
      type: TaskType.RESEARCH,
      steps: [
        makeStep('web_research', `Search for "${query}"`, { query, depth: 4 }),
        makeStep('analyze', 'Work out what matters', { instruction: text, limit: extractCount(text) ?? 8 }),
        makeStep('notify', 'Send the findings', { instruction: text, title: `Nexa: ${truncateTitle(query)}` }),
      ],
      permissions: [Permission.RESEARCH, Permission.READ, Permission.NOTIFY],
      recurrence,
      approvalRequired: false,
      method: 'rules',
    };
  }
}

/**
 * Looks at a finished task and decides whether it actually answered the
 * request. Returns extra steps when it did not, or nothing when it did.
 *
 * Only runs with a model configured: judging "is this a good enough answer"
 * is exactly the kind of call rules are bad at.
 */
export async function reflectOnTask(
  llm: LlmProvider,
  task: { naturalLanguageRequest: string; steps: { tool: string; description: string; status: string; output?: unknown }[] },
  tools: ToolRegistry,
): Promise<TaskStep[]> {
  if (!llm.available) return [];

  const done = task.steps.filter((step) => step.status === 'DONE');
  if (done.length === 0) return [];

  const summary = done
    .map((step) => {
      const output = step.output as { items?: unknown[]; text?: string; findings?: unknown[] } | undefined;
      const size =
        output?.items?.length ?? output?.findings?.length ?? (output?.text ? `${output.text.length} chars` : 'no data');
      return `- ${step.tool}: ${step.description} -> ${String(size)}`;
    })
    .join('\n');

  const result = await llm.complete({
    json: true,
    maxOutputTokens: 700,
    messages: [
      {
        role: 'system',
        content: [
          'You review a finished task for an operations agent and decide whether it answered the request.',
          '',
          'Available tools:',
          tools.describeForPlanner(),
          '',
          'Reply with JSON only: {"satisfied":true} when the work is adequate,',
          'or {"satisfied":false,"steps":[{"tool":"...","description":"...","input":{}}]} with at most two',
          'extra steps that would close the gap.',
          '',
          'Be strict about padding and lenient about ambition: ask for more only when the result clearly',
          'misses what was requested, not merely because more could be done.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: `Request: ${task.naturalLanguageRequest}\n\nWhat ran:\n${summary}`,
      },
    ],
  });

  const parsed = extractJson<{ satisfied?: boolean; steps?: { tool: string; description?: string; input?: Record<string, unknown> }[] }>(
    result.text,
  );

  if (!parsed || parsed.satisfied !== false || !parsed.steps) return [];

  return parsed.steps
    .filter((step) => tools.has(step.tool))
    .slice(0, 2)
    .map((step) => makeStep(step.tool, step.description ?? step.tool, step.input ?? {}));
}

function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && Object.values(TaskType).includes(value as TaskType);
}

function permissionsFor(steps: TaskStep[], tools: ToolRegistry): Permission[] {
  const granted = new Set<Permission>([Permission.READ]);
  for (const step of steps) {
    const tool = tools.get(step.tool);
    for (const permission of tool?.permissions ?? []) granted.add(permission);
  }
  return [...granted];
}

function normalizeRecurrence(recurrence?: Recurrence): Recurrence {
  if (!recurrence || !recurrence.kind) return { kind: 'once' };
  if (recurrence.kind === 'interval') {
    return { kind: 'interval', everySeconds: Math.max(300, recurrence.everySeconds ?? 3600) };
  }
  return recurrence;
}

export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"')]+/i);
  if (match) return match[0].replace(/[.,;]$/, '');
  // Bare domains, e.g. "watch example.com/pricing"
  const bare = text.match(/\b([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?/i);
  if (bare && !bare[0].endsWith('.')) return `https://${bare[0]}`;
  return null;
}

export function parseRecurrence(lower: string): Recurrence {
  const everyHours = lower.match(/every\s+(\d+)\s*(hours?|hrs?|h)\b/);
  if (everyHours) return { kind: 'interval', everySeconds: Number(everyHours[1]) * 3600 };

  const everyMinutes = lower.match(/every\s+(\d+)\s*(minutes?|mins?|m)\b/);
  if (everyMinutes) return { kind: 'interval', everySeconds: Math.max(300, Number(everyMinutes[1]) * 60) };

  const weekday = lower.match(/every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)/);
  if (weekday) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    return { kind: 'weekly', weekday: days.indexOf(weekday[1] as string), at: extractTimeOfDay(lower) ?? '08:00' };
  }

  if (/\b(every day|daily|each day|every morning|every evening|every night)\b/.test(lower)) {
    const fallback = /evening|night/.test(lower) ? '19:00' : '08:00';
    return { kind: 'daily', at: extractTimeOfDay(lower) ?? fallback };
  }

  if (/\bevery week|weekly\b/.test(lower)) {
    return { kind: 'weekly', weekday: 1, at: extractTimeOfDay(lower) ?? '08:00' };
  }

  return { kind: 'once' };
}

export function extractTimeOfDay(lower: string): string | null {
  const explicit = lower.match(/\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\s*(am|pm)?/);
  if (explicit) {
    let hour = Number(explicit[1]);
    const minute = explicit[2] as string;
    const suffix = explicit[3];
    if (suffix === 'pm' && hour < 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${minute}`;
  }

  const oclock = lower.match(/\bat\s+(\d{1,2})\s*(am|pm)\b/);
  if (oclock) {
    let hour = Number(oclock[1]);
    if (oclock[2] === 'pm' && hour < 12) hour += 12;
    if (oclock[2] === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:00`;
  }

  return null;
}

function extractCount(text: string): number | null {
  const match = text.match(/\b(\d{1,2})\b(?=[^.]*\b(job|jobs|role|roles|result|results|item|items|option|options)\b)/i);
  return match ? Math.min(50, Number(match[1])) : null;
}

function extractKeywords(text: string): string[] {
  const quoted = [...text.matchAll(/"([^"]{2,40})"/g)].map((m) => m[1] as string);
  if (quoted.length > 0) return quoted;
  const after = text.match(/\b(?:when|if)\b(.{3,80})/i);
  if (!after) return [];
  return (after[1] as string)
    .split(/[,/]| and | or /i)
    .map((part) => part.replace(/[^a-z0-9 +#.-]/gi, '').trim())
    .filter((part) => part.length > 2)
    .slice(0, 5);
}

function buildJobQuery(text: string, profile: UserProfile): string {
  const roles = profile.preferredRoles.length > 0 ? profile.preferredRoles.slice(0, 3).join(' OR ') : '';
  const remote = profile.remotePreference === 'remote' ? 'remote' : '';
  const explicit = stripCommandWords(text);
  return [explicit, roles, remote, 'jobs'].filter(Boolean).join(' ').slice(0, 220);
}

/**
 * Trims the scaffolding around a request so the remainder reads as a title.
 * Scheduling phrases go first: "every morning at 8am research X" should be
 * called "research X", not "at 8am research X".
 */
function stripCommandWords(text: string): string {
  return text
    .replace(/\bevery\s+(morning|evening|night|day|week|weekday|\w+day|\d+\s*\w+)\b/gi, ' ')
    .replace(/\b(at|by)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, ' ')
    .replace(/\b(daily|weekly|hourly)\b/gi, ' ')
    .replace(/^\s*[,.;:-]+/, '')
    .replace(/^\s*(please\s+)?(can you\s+)?(find|get|research|look up|search for|tell me about|send me|show me)\s+/i, '')
    .replace(/\band send (me |it |them )?(on|to|via)? ?telegram\b/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean || 'Task';
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
}
