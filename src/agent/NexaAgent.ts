import { EventEmitter } from 'node:events';
import { toolsForCapability, Planner, reflectOnTask, type ControlIntent, type Plan } from './Planner';
import { Clarifier, type ClarifyingQuestion } from './Clarifier';
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
import { CalendarTool } from '../tools/CalendarTool';
import { NotesTool } from '../tools/NotesTool';
import { MailTool } from '../tools/MailTool';
import { MailReadTool } from '../tools/MailReadTool';
import { NotifyTool } from '../tools/NotifyTool';
import { BrowserManager, ProfileInUseError } from '../browser/BrowserManager';
import { EvidenceStore } from '../evidence/EvidenceStore';
import { NotificationManager } from '../notifications/NotificationManager';
import { McpClient } from '../mcp/McpClient';
import { McpTool } from '../mcp/McpTool';
import { createLlmProvider } from '../llm/providers';
import type { LlmProvider } from '../llm/LLMProvider';
import { loadConfig, saveConfig, type AppConfig } from '../config/config';
import type { BrowserProfile, McpServerConfig } from '../config/schema';
import type { Permission } from '../tasks/Task';
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
  /** Set when Nexa needs answers before it will start. */
  clarifying?: { questions: ClarifyingQuestion[]; interpretation: string };
}

/** An open question-and-answer exchange, keyed by who is asking. */
interface ClarificationSession {
  originalRequest: string;
  questions: ClarifyingQuestion[];
  answers: string[];
  askedAt: number;
  rounds: number;
  source: Task['source'];
  chatId: string | null;
}

/** Sessions go stale rather than lingering and confusing a later request. */
const CLARIFY_TTL_MS = 30 * 60_000;
const MAX_CLARIFY_ROUNDS = 2;

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
  mcp: { id: string; name: string; connected: boolean; tools: number }[];
  toolCount: number;
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
  private clarifier: Clarifier;
  /** One open clarification per asker: "desktop" or a Telegram chat id. */
  private readonly clarifications = new Map<string, ClarificationSession>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly mcpClients = new Map<string, McpClient>();

  constructor(config: AppConfig = loadConfig()) {
    super();
    this.config = config;

    this.activity = new ActivityLog();
    this.browser = new BrowserManager();
    this.evidence = new EvidenceStore();
    this.notifications = new NotificationManager(config.notifications);
    this.llm = createLlmProvider(config);
    this.planner = new Planner(this.llm, (reason) => this.reportModelFailure(reason));
    this.clarifier = new Clarifier(this.llm);

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
      // Adaptive: after the planned steps run, the agent may add a couple more
      // if the result clearly did not answer the request.
      reflect: (task) => reflectOnTask(this.llm, task, this.tools),
      maxAdaptiveSteps: 3,
    });

    // Anything the engines emit is forwarded so the UI can react.
    for (const source of [this.tasks, this.watchers] as EventEmitter[]) {
      for (const event of ['task', 'watcher', 'completed', 'failed', 'needs-human', 'needs-approval', 'changed']) {
        source.on(event, (payload: unknown) => this.emit(event, payload));
      }
    }
    this.activity.onEntry((entry) => this.emit('activity', entry));
  }

  /**
   * Accounts the clarifier may ask about.
   *
   * Empty whenever there is nothing to ask: mail switched off, a default
   * already chosen, or only one account to choose from.
   */
  private mailAccountsToAsk(): string[] {
    const mail = this.config.mail;
    if (!mail.enabled || mail.defaultAccount) return [];
    return mail.accounts;
  }

  /**
   * Surfaces a model failure once, rather than on every request.
   *
   * A broken provider fails identically every time; repeating it would bury
   * the activity log under the same line.
   */
  private reportModelFailure(reason: string): void {
    const short = reason.slice(0, 160).replace(/\s+/g, ' ');
    if (short === this.lastModelFailure) return;
    this.lastModelFailure = short;
    this.activity.add(`AI provider rejected the request, planning with rules instead: ${short}`, 'warn');
  }

  private lastModelFailure: string | null = null;

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
    this.tools.register(new CalendarTool(() => this.config.calendar));
    this.tools.register(new NotesTool(() => this.config.notes));
    this.tools.register(new MailTool(() => this.config.mail));
    this.tools.register(new MailReadTool(() => this.config.mail));
    this.tools.register(new NotifyTool(this.notifications, this.llm));
  }

  // ------------------------------------------------------------- life cycle

  start(): void {
    if (this.timer) return;

    // MCP servers are optional; a broken one must not stop Nexa starting.
    void this.connectMcpServers();

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
    await Promise.all([...this.mcpClients.values()].map((client) => client.disconnect()));
    this.mcpClients.clear();
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

  /**
   * Connects the configured MCP servers and registers their tools.
   *
   * Each server's tools are namespaced and run under that server's configured
   * permission grant, so borrowing a capability never widens a task's reach.
   */
  private async connectMcpServers(): Promise<void> {
    const servers = this.config.mcpServers.filter((server) => server.enabled);
    if (servers.length === 0) return;

    for (const server of servers) {
      try {
        const client = new McpClient(
          server.id,
          server.command,
          server.args,
          server.env,
          server.timeoutSeconds * 1000,
        );
        await client.connect();
        this.mcpClients.set(server.id, client);

        let registered = 0;
        for (const definition of client.listTools()) {
          const tool = new McpTool(client, definition, server.permissions as Permission[]);
          if (this.tools.has(tool.name)) continue;
          this.tools.register(tool);
          registered += 1;
        }

        this.activity.add(`Connected ${server.name || server.id}: ${registered} tool(s)`, 'success');
      } catch (err) {
        const message = (err as Error).message;
        log.warn({ server: server.id, err: message }, 'MCP server unavailable');
        this.activity.add(`Could not connect ${server.name || server.id}: ${message}`, 'warn');
      }
    }
  }

  mcpStatus(): { id: string; name: string; connected: boolean; tools: number }[] {
    return this.config.mcpServers.map((server: McpServerConfig) => {
      const client = this.mcpClients.get(server.id);
      return {
        id: server.id,
        name: server.name || server.id,
        connected: Boolean(client?.connected),
        tools: client?.listTools().length ?? 0,
      };
    });
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

    const askerKey = chatId ?? source;

    // An answer to an open question is not a new request.
    const pending = this.takeClarification(askerKey);
    if (pending) return this.continueClarification(pending, text, source, chatId);

    // Control phrases are never vague enough to need clarifying.
    const control = this.planner.detectControl(text);
    if (!control) {
      const clarity = await this.clarifier.assess(text, this.config.userProfile, this.mailAccountsToAsk());
      if (!clarity.clear && clarity.questions.length > 0) {
        return this.openClarification(askerKey, text, clarity.questions, clarity.interpretation, source, chatId);
      }
    }

    return this.createTaskFrom(text, source, chatId);
  }

  /** Plans a request that is specific enough, and queues it. */
  private async createTaskFrom(
    text: string,
    source: Task['source'],
    chatId: string | null,
  ): Promise<AgentResponse> {
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

  // ------------------------------------------------------------ clarifying

  /** Parks the request and asks, rather than guessing and doing the wrong job. */
  private openClarification(
    key: string,
    request: string,
    questions: ClarifyingQuestion[],
    interpretation: string,
    source: Task['source'],
    chatId: string | null,
  ): AgentResponse {
    const existing = this.clarifications.get(key);
    const rounds = (existing?.rounds ?? 0) + 1;

    this.clarifications.set(key, {
      originalRequest: request,
      questions,
      answers: [],
      askedAt: Date.now(),
      rounds,
      source,
      chatId,
    });

    this.activity.add(`Asking before starting: ${questions.length} question(s)`, 'info');

    const lines = [
      `Before I start, ${questions.length === 1 ? 'one thing' : `${questions.length} things`}:`,
      '',
      ...questions.flatMap((question, index) => {
        const parts = [`${index + 1}. ${question.question}`];
        if (question.why) parts.push(`   (${question.why})`);
        if (question.suggestions.length > 0) parts.push(`   e.g. ${question.suggestions.join(' / ')}`);
        return parts;
      }),
      '',
      questions.length === 1
        ? 'Reply with the answer, or say "just do it" and I will use my best guess.'
        : 'Reply with the answers on one line, or say "just do it" and I will use my best guess.',
    ];

    return { text: lines.join('\n'), created: false, clarifying: { questions, interpretation } };
  }

  /** Folds the answers in and either starts, or asks once more. */
  private async continueClarification(
    session: ClarificationSession,
    answer: string,
    source: Task['source'],
    chatId: string | null,
  ): Promise<AgentResponse> {
    // Splitting on separators lets one line answer several questions.
    const answers =
      session.questions.length > 1
        ? answer.split(/\s*[;|]\s*|\s+-\s+/).map((part) => part.trim())
        : [answer.trim()];

    const merged = this.clarifier.merge(session.originalRequest, session.questions, answers);
    this.activity.add('Got the detail, planning now', 'info');

    // One more check, but never an endless interrogation.
    if (session.rounds < MAX_CLARIFY_ROUNDS) {
      const clarity = await this.clarifier.assess(merged, this.config.userProfile, this.mailAccountsToAsk());
      if (!clarity.clear && clarity.questions.length > 0) {
        const key = chatId ?? source;
        this.clarifications.set(key, { ...session, originalRequest: merged, rounds: session.rounds });
        return this.openClarification(key, merged, clarity.questions, clarity.interpretation, source, chatId);
      }
    }

    return this.createTaskFrom(merged, source, chatId);
  }

  private takeClarification(key: string): ClarificationSession | null {
    const session = this.clarifications.get(key);
    if (!session) return null;
    this.clarifications.delete(key);
    // A stale session would attach an old question to an unrelated request.
    if (Date.now() - session.askedAt > CLARIFY_TTL_MS) return null;
    return session;
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
      notes: 'I have no access to your notes, so I cannot save anything there.',
      'reading mail': 'I cannot open your inbox, so I do not know what has arrived. Searching the web for it would tell you nothing.',
    };

    // Reaching here with a tool registered means planning failed, not that the
    // capability is missing. Saying "I have no calendar access" would be a lie,
    // and would send the user looking for a setting that is already on.
    const enabling = toolsForCapability(capability, this.tools);
    const opening =
      enabling.length > 0
        ? `I could not turn that into a ${capability} step, so I have not done anything. ` +
          `I do have ${enabling.length === 1 ? 'a tool for it' : 'tools for it'} ` +
          `(${enabling.join(', ')}). ${RETRY_HINTS[capability] ?? 'Try again, more specifically.'}`
        : `I cannot do that. ${alternatives[capability] ?? `I have no tool for ${capability}.`}`;

    return [
      opening,
      '',
      'What I can do:',
      ...this.describeCapabilities().map((line) => `- ${line}`),
      '',
      'If you want the information rather than the action, ask me to research it.',
    ].join('\n');
  }

  /**
   * The "what I can do" list, built from what is actually registered.
   *
   * Hardcoding it meant every tool added -- built in or borrowed over MCP --
   * left Nexa describing itself as it was months ago. The built-ins get hand
   * written lines because "web_research: Search the web" reads like a manual;
   * anything else falls back to its own description.
   */
  private describeCapabilities(): string[] {
    const written: Record<string, string> = {
      web_research: 'research something and report back',
      watcher: 'watch a page or search and tell you when it meaningfully changes',
      browser: 'run a browser workflow and collect what it finds',
      files: 'read files in folders you have allowed',
      notes: this.config.notes.enabled
        ? 'save notes to your Notes app'
        : 'save notes to your Notes app, once you have turned that on under Settings',
      mail_read: this.config.mail.enabled
        ? 'check your inbox and tell you what has arrived'
        : '',
      mail: this.config.mail.enabled
        ? `write email${this.config.mail.allowSend ? ' and send it' : ' as a draft for you to send'}`
        : 'write email, once you have turned that on under Settings',
      calendar: this.config.calendar.enabled
        ? 'put events in your calendar'
        : 'put events in your calendar, once you have turned that on under Settings',
      analyze: '',
      notify: '',
    };

    const lines = this.tools.list().map((tool) => {
      const line = written[tool.name];
      if (line !== undefined) return line;
      return `${tool.name}: ${firstSentence(tool.description)}`;
    });

    return [...lines.filter(Boolean), 'repeat any of those on a schedule'];
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
    this.clarifier = new Clarifier(this.llm);
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
      mcp: this.mcpStatus(),
      toolCount: this.tools.list().length,
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

/**
 * What to try instead, per capability.
 *
 * A generic "try again" is useless, and the advice differs: a calendar step
 * fails for want of a time, while an inbox request fails for want of a window.
 */
const RETRY_HINTS: Record<string, string> = {
  calendar: 'Try again with the exact date and time.',
  notes: 'Try again saying what the note should be called and what goes in it.',
  messaging: 'Try again with the recipient address and what you want it to say.',
  'reading mail': 'Try again saying how far back to look, for example "unread mail from today".',
  'writing files': 'Try again naming the file and what should go in it.',
};

/** First sentence of a tool description, for the capability list. */
function firstSentence(description: string): string {
  const stripped = description.replace(/\s*Input:.*$/s, '').trim();
  const end = stripped.search(/\.(\s|$)/);
  return (end === -1 ? stripped : stripped.slice(0, end)).trim();
}
