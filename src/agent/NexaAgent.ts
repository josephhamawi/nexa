import { EventEmitter } from 'node:events';
import { Planner, type ControlIntent, type Plan } from './Planner';
import { ActivityLog } from './ActivityLog';
import { TaskEngine } from '../tasks/TaskEngine';
import { WatcherEngine } from '../watchers/WatcherEngine';
import {
  TaskStatus,
  createTask,
  describeRecurrence,
  isTerminal,
  isWaitingOnHuman,
  type Task,
} from '../tasks/Task';
import { ToolRegistry } from '../tools/Tool';
import { WebResearchTool } from '../tools/WebResearchTool';
import { AnalysisTool } from '../tools/AnalysisTool';
import { BrowserTool } from '../tools/BrowserTool';
import { WatcherTool } from '../tools/WatcherTool';
import { FileTool } from '../tools/FileTool';
import { NotifyTool } from '../tools/NotifyTool';
import { BrowserManager, ProfileInUseError } from '../browser/BrowserManager';
import { EvidenceStore } from '../evidence/EvidenceStore';
import { NotificationManager } from '../notifications/NotificationManager';
import { createLlmProvider } from '../llm/providers';
import type { LlmProvider } from '../llm/LLMProvider';
import { loadConfig, saveConfig, type AppConfig } from '../config/config';
import type { BrowserProfile } from '../config/schema';
import { childLogger } from '../logging/logger';
import { hostOf } from './Planner';

const log = childLogger('agent');

/** How long Nexa keeps its hands off after you touch the browser. */
const USER_ACTIVITY_GRACE_MS = 3 * 60_000;
const TICK_MS = 5000;

export interface AgentResponse {
  /** Message to send back to whoever asked. */
  text: string;
  task?: Task;
  /** True when a task was created and is now queued. */
  created?: boolean;
}

export interface DashboardState {
  agent: {
    running: boolean;
    demoMode: boolean;
    llm: { provider: string; model: string; available: boolean };
  };
  counts: {
    activeTasks: number;
    runningWatchers: number;
    pendingApprovals: number;
    waitingForHuman: number;
    completedToday: number;
    failedToday: number;
  };
  tasks: Task[];
  history: Task[];
  watchers: ReturnType<WatcherEngine['all']>;
  notifications: ReturnType<NotificationManager['status']>;
  browser: { profiles: BrowserProfile[]; active: string[]; inUseByHuman: boolean };
  userProfile: AppConfig['userProfile'];
}

/**
 * The top of the agent stack.
 *
 * Everything the user can ask for arrives here, whether it came from Telegram
 * or the dashboard, and leaves as a task with a plan, permissions and an audit
 * trail. Nothing else in the codebase needs to know which interface was used.
 */
export class NexaAgent extends EventEmitter {
  readonly activity: ActivityLog;
  readonly tasks: TaskEngine;
  readonly watchers: WatcherEngine;
  readonly notifications: NotificationManager;
  readonly browser: BrowserManager;
  readonly tools: ToolRegistry;
  readonly evidence: EvidenceStore;

  private config: AppConfig;
  private llm: LlmProvider;
  private planner: Planner;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(config: AppConfig = loadConfig()) {
    super();
    this.config = config;

    this.activity = new ActivityLog();
    this.browser = new BrowserManager();
    this.evidence = new EvidenceStore();
    this.notifications = new NotificationManager(config.notifications);
    this.llm = createLlmProvider(config);
    this.planner = new Planner(this.llm);

    this.watchers = new WatcherEngine(this.browser, this.notifications, this.activity, {
      minIntervalSeconds: config.agent.minWatchIntervalSeconds,
      demoMode: () => this.config.agent.demoMode,
      resolveProfile: (id) => this.resolveProfile(id),
    });

    this.tools = new ToolRegistry();
    this.registerTools();

    this.tasks = new TaskEngine(this.tools, this.evidence, this.notifications, this.activity, {
      maxStepRetries: config.agent.maxStepRetries,
      requireApprovalForWrites: config.agent.requireApprovalForWrites,
      isBrowserBusy: () => this.browser.userActiveWithin(USER_ACTIVITY_GRACE_MS),
    });

    // Anything the engines emit is forwarded so the UI can react.
    for (const source of [this.tasks, this.watchers] as EventEmitter[]) {
      for (const event of ['task', 'watcher', 'completed', 'failed', 'needs-human', 'needs-approval', 'changed']) {
        source.on(event, (payload: unknown) => this.emit(event, payload));
      }
    }
    this.activity.onEntry((entry) => this.emit('activity', entry));
  }

  private registerTools(): void {
    const demoMode = (): boolean => this.config.agent.demoMode;

    this.tools.register(new WebResearchTool(this.llm, demoMode));
    this.tools.register(new AnalysisTool(this.llm, () => this.config.userProfile));
    this.tools.register(
      new BrowserTool(this.browser, this.evidence, (id) => this.resolveProfile(id), demoMode),
    );
    this.tools.register(
      new WatcherTool({
        create: (input) => this.watchers.create(input),
        list: () => this.watchers.all(),
        setStatus: (id, status) => this.watchers.setStatus(id, status),
        remove: (id) => this.watchers.remove(id),
        minIntervalSeconds: () => this.config.agent.minWatchIntervalSeconds,
      }),
    );
    this.tools.register(new FileTool(() => this.config.files));
    this.tools.register(new NotifyTool(this.notifications, this.llm));
  }

  // ------------------------------------------------------------- life cycle

  start(): void {
    if (this.timer) return;

    const { requeued, waiting } = this.tasks.recoverOnStartup();
    const restored = this.watchers.recoverOnStartup();
    this.activity.add(
      `Nexa started. ${requeued} task(s) requeued, ${waiting} waiting on you, ${restored} watcher(s) rescheduled.`,
      'info',
    );

    this.timer = setInterval(() => void this.tick(), TICK_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.emit('state', this.dashboardState());
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.browser.closeAll();
    this.activity.add('Nexa stopped', 'info');
  }

  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * One pass of the scheduler: run a due task, then check a due watcher.
   *
   * Strictly one thing at a time. The agent is sharing a machine and a browser
   * with a person, so overlapping work would fight over both.
   */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;

    try {
      // Never take the browser while a person is using it.
      const humanBusy = this.browser.userActiveWithin(USER_ACTIVITY_GRACE_MS);

      if (!this.tasks.isBusy) {
        const due = this.tasks.due()[0];
        if (due) {
          if (humanBusy && due.permissions.includes('BROWSER')) {
            log.debug({ task: due.id }, 'browser in use by hand, deferring task');
          } else {
            await this.tasks.run(due.id);
            this.emit('state', this.dashboardState());
          }
        }
      }

      if (!this.watchers.isBusy && !this.tasks.isBusy && !humanBusy) {
        const due = this.watchers.due()[0];
        if (due) {
          await this.watchers.check(due.id);
          this.emit('state', this.dashboardState());
        }
      }
    } catch (err) {
      if (err instanceof ProfileInUseError) {
        this.activity.add(err.message, 'error');
      } else {
        log.error({ err: (err as Error).message }, 'tick failed');
      }
    } finally {
      this.ticking = false;
    }
  }

  // ---------------------------------------------------------------- requests

  /**
   * The single entry point for natural language, wherever it came from.
   * Control phrases are answered directly; everything else becomes a task.
   */
  async handleRequest(
    request: string,
    source: Task['source'] = 'desktop',
    chatId: string | null = null,
  ): Promise<AgentResponse> {
    const text = request.trim();
    if (!text) return { text: 'Say what you need and I will get on with it.' };

    this.activity.add(`Request: ${text.slice(0, 120)}`, 'info');

    const plan = await this.planner.plan(text, {
      profile: this.config.userProfile,
      tools: this.tools,
      defaultWatchIntervalSeconds: Math.max(this.config.agent.minWatchIntervalSeconds, 21_600),
    });

    if (plan.control) return this.handleControl(plan.control);

    // Saying "I cannot do that" is the whole point of this branch. Falling
    // through to a web search would return something that looks like success.
    if (plan.unsupported) {
      this.activity.add(`Declined: no tool for ${plan.unsupported.capability}`, 'warn');
      return { text: this.describeUnsupported(plan.unsupported.capability), created: false };
    }

    const task = this.tasks.add(
      createTask({
        name: plan.name,
        description: plan.description,
        naturalLanguageRequest: text,
        type: plan.type,
        steps: plan.steps,
        permissions: plan.permissions,
        tools: [...new Set(plan.steps.map((step) => step.tool))],
        recurrence: plan.recurrence,
        approvalRequired: plan.approvalRequired,
        source,
        sourceChatId: chatId,
      }),
    );

    this.tasks.enqueue(task.id);
    this.emit('state', this.dashboardState());

    return {
      text: this.describePlan(plan, task),
      task: this.tasks.get(task.id),
      created: true,
    };
  }

  private describePlan(plan: Plan, task: Task): string {
    const lines = [
      `Task created: ${plan.name}`,
      '',
      `Plan (${plan.method === 'model' ? 'AI-planned' : 'rule-based'}):`,
      ...plan.steps.map((step, index) => `${index + 1}. ${step.description}`),
    ];

    if (plan.recurrence.kind !== 'once') lines.push('', `Repeats: ${describeRecurrence(plan.recurrence)}`);
    if (plan.approvalRequired) lines.push('', 'I will ask before anything that changes something.');
    lines.push('', `I will report back when it is done. (id ${task.id.slice(0, 8)})`);

    return lines.join('\n');
  }

  /**
   * Explains the gap honestly and points at what Nexa can actually do, rather
   * than quietly substituting a weaker action.
   */
  private describeUnsupported(capability: string): string {
    const alternatives: Record<string, string> = {
      calendar: 'I have no calendar access, so I cannot create events or reminders.',
      messaging: 'I cannot send email, SMS or chat messages on your behalf. I only report back to you, here and on Telegram.',
      purchasing: 'I will not buy, order or pay for anything. That stays yours.',
      'social posting': 'I cannot post to social accounts.',
      'form submission': 'I will not submit applications or forms for you.',
      'writing files': 'I can read files in folders you allow, but I do not create, edit or delete them.',
    };

    return [
      `I cannot do that. ${alternatives[capability] ?? `I have no tool for ${capability}.`}`,
      '',
      'What I can do:',
      '- research something and report back',
      '- watch a page or search and tell you when it meaningfully changes',
      '- run a browser workflow and collect what it finds',
      '- read files in folders you have allowed',
      '- repeat any of those on a schedule',
      '',
      'If you want the information rather than the action, ask me to research it.',
    ].join('\n');
  }

  private handleControl(control: ControlIntent): AgentResponse {
    switch (control.action) {
      case 'help':
        return { text: HELP_TEXT };

      case 'status': {
        const state = this.dashboardState();
        return {
          text: [
            `Nexa is ${state.agent.running ? 'running' : 'idle'}${state.agent.demoMode ? ' (demo mode)' : ''}.`,
            `Model: ${state.agent.llm.available ? `${state.agent.llm.provider} ${state.agent.llm.model}` : 'none, planning with rules'}`,
            '',
            `Active tasks: ${state.counts.activeTasks}`,
            `Watchers: ${state.counts.runningWatchers}`,
            `Waiting on you: ${state.counts.waitingForHuman + state.counts.pendingApprovals}`,
            `Completed today: ${state.counts.completedToday}`,
          ].join('\n'),
        };
      }

      case 'list_tasks': {
        const active = this.tasks.active();
        if (active.length === 0) return { text: 'Nothing running. Tell me what you need.' };
        return {
          text: ['Active tasks:', '', ...active.map(formatTaskLine)].join('\n'),
        };
      }

      case 'list_watchers': {
        const watchers = this.watchers.all();
        if (watchers.length === 0) return { text: 'No watchers yet. Try: watch example.com and tell me when it changes.' };
        return {
          text: [
            'Watchers:',
            '',
            ...watchers.map(
              (watcher) =>
                `- ${watcher.name} [${watcher.status.toLowerCase()}] ${hostOf(watcher.target)}, every ${Math.round(
                  watcher.intervalSeconds / 60,
                )} min${watcher.lastChanged ? `, last change ${new Date(watcher.lastChanged).toLocaleString()}` : ''}`,
            ),
          ].join('\n'),
        };
      }

      case 'pause':
      case 'resume': {
        const wantActive = control.action === 'resume';
        const target = control.target ?? '';

        const task = target ? this.tasks.findByDescription(target) : this.tasks.active()[0];
        if (task) {
          const updated = wantActive ? this.tasks.resume(task.id) : this.tasks.pause(task.id);
          this.emit('state', this.dashboardState());
          return { text: `${updated?.name ?? task.name} is now ${wantActive ? 'running again' : 'paused'}.` };
        }

        const watcher = target ? this.watchers.findByDescription(target) : this.watchers.active()[0];
        if (watcher) {
          const updated = this.watchers.setStatus(watcher.id, wantActive ? 'ACTIVE' : 'PAUSED');
          this.emit('state', this.dashboardState());
          return { text: `${updated?.name ?? watcher.name} is now ${wantActive ? 'active' : 'paused'}.` };
        }

        return { text: `I could not find anything matching "${target}".` };
      }

      case 'cancel': {
        const target = control.target ?? '';
        const task = this.tasks.findByDescription(target);
        if (task) {
          this.tasks.cancel(task.id);
          this.emit('state', this.dashboardState());
          return { text: `Cancelled ${task.name}.` };
        }
        const watcher = this.watchers.findByDescription(target);
        if (watcher) {
          this.watchers.remove(watcher.id);
          this.emit('state', this.dashboardState());
          return { text: `Deleted watcher ${watcher.name}.` };
        }
        return { text: `Nothing matching "${target}" to cancel.` };
      }

      case 'stop_all': {
        const tasks = this.tasks.active();
        for (const task of tasks) this.tasks.cancel(task.id);
        for (const watcher of this.watchers.active()) this.watchers.setStatus(watcher.id, 'PAUSED');
        this.emit('state', this.dashboardState());
        return { text: `Stopped ${tasks.length} task(s) and paused every watcher.` };
      }

      default:
        return { text: HELP_TEXT };
    }
  }

  // ------------------------------------------------------- human in the loop

  approve(taskId: string, approved: boolean): Task | undefined {
    const task = this.tasks.approve(taskId, approved);
    this.emit('state', this.dashboardState());
    return task;
  }

  resumeTask(taskId: string): Task | undefined {
    // Pressing Resume is the user handing control back.
    this.browser.clearUserActivity();
    const task = this.tasks.resume(taskId);
    this.emit('state', this.dashboardState());
    return task;
  }

  /** Brings the browser forward so the user can finish a blocked step. */
  async openBrowser(profileId = 'default'): Promise<void> {
    const profile = this.resolveProfile(profileId);
    await this.browser.getPage(profile);
    await this.browser.bringToFront(profileId);
    this.activity.add('Browser brought to the front', 'info');
  }

  // ------------------------------------------------------------------ config

  getConfig(): AppConfig {
    return this.config;
  }

  applyConfig(next: AppConfig): AppConfig {
    this.config = saveConfig(next);
    this.notifications.updateConfig(this.config.notifications);
    this.llm = createLlmProvider(this.config);
    this.planner = new Planner(this.llm);
    this.tasks.updateOptions({
      maxStepRetries: this.config.agent.maxStepRetries,
      requireApprovalForWrites: this.config.agent.requireApprovalForWrites,
    });
    this.watchers.updateOptions({ minIntervalSeconds: this.config.agent.minWatchIntervalSeconds });
    this.activity.add('Settings updated', 'info');
    this.emit('state', this.dashboardState());
    return this.config;
  }

  resolveProfile(id: string): BrowserProfile {
    const found = this.config.browserProfiles.find((profile: BrowserProfile) => profile.id === id);
    if (found) return found;
    return (
      this.config.browserProfiles[0] ?? {
        id: 'default',
        name: 'Default',
        engine: 'chromium' as const,
        headless: false,
        createdAt: new Date().toISOString(),
        lastUsed: null,
      }
    );
  }

  dashboardState(): DashboardState {
    const tasks = this.tasks.all();
    const today = new Date().toDateString();
    const finishedToday = (status: TaskStatus): number =>
      tasks.filter((task) => task.status === status && new Date(task.updatedAt).toDateString() === today).length;

    return {
      agent: {
        running: this.isRunning,
        demoMode: this.config.agent.demoMode,
        llm: { provider: this.llm.name, model: this.llm.model, available: this.llm.available },
      },
      counts: {
        activeTasks: tasks.filter((task) => !isTerminal(task.status)).length,
        runningWatchers: this.watchers.active().length,
        pendingApprovals: tasks.filter((task) => task.status === TaskStatus.WAITING_FOR_APPROVAL).length,
        waitingForHuman: tasks.filter((task) => task.status === TaskStatus.WAITING_FOR_HUMAN).length,
        completedToday: finishedToday(TaskStatus.COMPLETED),
        failedToday: finishedToday(TaskStatus.FAILED),
      },
      tasks: tasks.filter((task) => !isTerminal(task.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      history: this.tasks.history(30),
      watchers: this.watchers.all(),
      notifications: this.notifications.status(),
      browser: {
        profiles: this.config.browserProfiles,
        active: this.browser.activeProfiles(),
        inUseByHuman: this.browser.userActiveWithin(USER_ACTIVITY_GRACE_MS),
      },
      userProfile: this.config.userProfile,
    };
  }
}

function formatTaskLine(task: Task): string {
  const waiting = isWaitingOnHuman(task.status) ? ' <- needs you' : '';
  const next = task.nextRun ? `, next ${new Date(task.nextRun).toLocaleString()}` : '';
  return `- ${task.name} [${task.status.toLowerCase()}] ${task.progress}%${next}${waiting} (id ${task.id.slice(0, 8)})`;
}

const HELP_TEXT = [
  'Nexa, your AI operations agent.',
  '',
  'Just say what you need, for example:',
  '- research the latest AI agent frameworks and send me a summary',
  '- find 5 remote AI engineering jobs that match my profile',
  '- watch example.com/pricing and tell me when it changes',
  '- open example.com every Friday and send me the headlines',
  '- do that every morning at 8am',
  '',
  'Commands: /status /tasks /watches /pause /resume /cancel /help',
].join('\n');

export { HELP_TEXT };
