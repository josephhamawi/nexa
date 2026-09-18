import { EventEmitter } from 'node:events';
import { BrowserManager, ProfileInUseError } from '../browser/BrowserManager';
import { SessionManager } from '../browser/SessionManager';
import { BlsSpainAdapter } from '../bls/BlsSpainAdapter';
import { BLS_URLS } from '../bls/BlsSelectors';
import { mergeOptions, seededOptions, type BlsFormOptions } from '../bls/BlsFormOptions';
import {
  detectAuthenticated,
  detectHumanVerification,
  detectLoginRequired,
} from '../bls/BlsPageDetector';
import { BlsErrorCode } from '../bls/errors';
import { MonitorWorker } from './MonitorWorker';
import { Scheduler, computeIntervalRange } from './Scheduler';
import {
  createInitialState,
  restoreState,
  rollDailyStats,
  type MonitorState,
} from './MonitorState';
import { StateStore } from '../storage/StateStore';
import { EventStore, type MonitorEvent } from '../storage/EventStore';
import { NotificationManager } from '../notifications/NotificationManager';
import {
  AvailabilityStatus,
  describeStatus,
  isAppointmentFoundTransition,
  isErrorStatus,
  requiresManualAction,
} from '../availability/AvailabilityState';
import { describeSlots, type AvailabilityResult } from '../availability/AvailabilityResult';
import type { AppConfig } from '../config/schema';
import { ensureDataDirs, loadConfig, paths } from '../config/config';
import fs from 'node:fs';
import path from 'node:path';
import { formatDuration } from '../utils/time';
import { childLogger } from '../logging/logger';

const log = childLogger('monitor');

/**
 * How long the monitor keeps its hands off after you touch the browser.
 *
 * Navigating the page out from under someone who is mid-booking destroys the
 * verification they just solved, so a scheduled check waits instead.
 */
const USER_ACTIVITY_GRACE_MS = 3 * 60_000;

export interface DashboardState {
  identity: {
    country: 'Spain';
    city: 'Lagos';
    applicationCountry: 'Nigeria';
    centre: 'Lagos';
    visaType: string;
    visaSubCategory: string;
    applicantType: string;
    memberCount: number;
  };
  runState: MonitorState['runState'];
  status: AvailabilityStatus;
  statusLabel: string;
  availabilityMessage: string;
  lastCheck: string | null;
  nextCheck: string | null;
  stats: MonitorState['stats'];
  appointments: AvailabilityResult['appointments'];
  screenshotPath: string | null;
  manualActionRequired: boolean;
  manualActionReason: string | null;
  sessionStatus: string;
  notifications: ReturnType<NotificationManager['status']>;
  browserOpen: boolean;
  browserInUse: boolean;
  errorCount: number;
  lastError: MonitorState['lastError'];
  intervalRange: { minSeconds: number; maxSeconds: number; tier: string };
  preferences: {
    preferredDateFrom: string;
    preferredDateTo: string;
    preferredTimeFrom: string;
    preferredTimeTo: string;
    intervalMinSeconds: number;
    intervalMaxSeconds: number;
  };
  manualCheckCooldownSeconds: number;
  cooldownRemainingSeconds: number;
}

export interface CheckNowOutcome {
  accepted: boolean;
  reason?: string;
  result?: AvailabilityResult;
}

/**
 * Owns the monitoring lifecycle: one browser, one adapter, one scheduler, one
 * worker. Everything the UI and the CLI do goes through this object.
 */
export class MonitorManager extends EventEmitter {
  private config: AppConfig;
  private state: MonitorState;
  private readonly browser: BrowserManager;
  private readonly session: SessionManager;
  private readonly adapter: BlsSpainAdapter;
  private readonly worker: MonitorWorker;
  private readonly scheduler: Scheduler;
  private readonly stateStore: StateStore;
  readonly events: EventStore;
  readonly notifications: NotificationManager;

  /** Consecutive structure-change failures, escalates to a notification. */
  private structureFailures = 0;
  /** Polls the already-open page while you complete a CAPTCHA or a login. */
  private takeoverWatch: NodeJS.Timeout | null = null;

  constructor(config: AppConfig = loadConfig()) {
    super();
    this.config = config;
    this.notifications = new NotificationManager(config.notifications);
    this.stateStore = new StateStore();
    this.events = new EventStore();
    this.state = restoreState(this.stateStore.load());
    this.session = new SessionManager();
    this.browser = new BrowserManager(config.bls.headless);
    this.adapter = new BlsSpainAdapter(this.browser, this.session, config.bls);
    this.worker = new MonitorWorker(this.adapter);
    this.scheduler = new Scheduler({
      minSeconds: config.bls.intervalMinSeconds,
      maxSeconds: config.bls.intervalMaxSeconds,
    });

    this.events.onEvent((event) => this.emit('event', event));
  }

  // ------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.state.runState === 'RUNNING') {
      this.log('Monitoring already running', 'info');
      return;
    }
    if (!this.config.bls.enabled) {
      this.log('BLS monitoring is disabled in config.json', 'warn');
      return;
    }

    this.patch({
      runState: 'RUNNING',
      currentStatus: AvailabilityStatus.MONITORING,
      manualActionRequired: false,
      manualActionReason: null,
    });
    this.log('Monitoring started', 'info');

    if (!(await this.launchBrowser())) return;
    void this.runCheck('scheduled');
  }

  pause(reason = 'Paused by user'): void {
    this.stopTakeoverWatch();
    this.scheduler.cancel();
    this.patch({
      runState: 'PAUSED',
      currentStatus: AvailabilityStatus.PAUSED,
      nextCheck: null,
    });
    this.log(reason, 'warn');
  }

  /** Resume after a CAPTCHA/login takeover, or after a manual pause. */
  async resume(): Promise<void> {
    this.stopTakeoverWatch();
    // Pressing Resume is you handing control back.
    this.browser.clearUserActivity();
    this.structureFailures = 0;
    this.patch({
      runState: 'RUNNING',
      currentStatus: AvailabilityStatus.MONITORING,
      manualActionRequired: false,
      manualActionReason: null,
    });
    this.log('Monitoring resumed', 'info');
    if (!(await this.launchBrowser())) return;
    void this.runCheck('scheduled');
  }

  async stop(closeBrowser = false): Promise<void> {
    this.stopTakeoverWatch();
    this.scheduler.cancel();
    this.worker.abort();
    this.patch({
      runState: 'STOPPED',
      currentStatus: AvailabilityStatus.STOPPED,
      nextCheck: null,
    });
    this.log('Monitoring stopped', 'warn');
    if (closeBrowser) await this.browser.close();
  }

  /** Manual CHECK NOW, subject to the configured cooldown. */
  async checkNow(): Promise<CheckNowOutcome> {
    const remaining = this.cooldownRemainingSeconds();
    if (remaining > 0) {
      return {
        accepted: false,
        reason: `Please wait before checking again (${remaining}s).`,
      };
    }
    if (this.worker.isRunning) {
      return { accepted: false, reason: 'A check is already running.' };
    }

    this.patch({ lastManualCheckAt: Date.now() });
    const result = await this.runCheck('manual');
    return result ? { accepted: true, result } : { accepted: false, reason: 'Check could not start.' };
  }

  cooldownRemainingSeconds(): number {
    const last = this.state.lastManualCheckAt;
    if (!last) return 0;
    const elapsed = (Date.now() - last) / 1000;
    return Math.max(0, Math.ceil(this.config.bls.manualCheckCooldownSeconds - elapsed));
  }

  // ---------------------------------------------------------------- browser

  /** Opens (or focuses) Chromium on the BLS portal for manual takeover. */
  async openBrowser(): Promise<void> {
    if (!(await this.launchBrowser())) return;
    const page = await this.browser.getPage();
    if (page.url() === 'about:blank') {
      // Never the login route here: opening it would end a live session.
      await page.goto(BLS_URLS.entry, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    await this.browser.bringToFront();
    this.log('Browser brought to the foreground', 'info');
  }

  /**
   * Opens the BLS login page for a manual sign-in and starts watching for you
   * to finish. Credentials are typed by you, into the browser, this method
   * only navigates and raises the window.
   */
  async openLoginPage(): Promise<void> {
    if (!(await this.launchBrowser())) return;
    const page = await this.browser.getPage();
    await page
      .goto(BLS_URLS.login, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      .catch((err: Error) => log.warn({ err: err.message }, 'could not open the login page'));
    await this.browser.bringToFront();
    this.log('Login page opened. Sign in and complete the verification yourself.', 'info');

    this.patch({ manualActionRequired: true, manualActionReason: 'Waiting for you to sign in to BLS.' });
    this.startTakeoverWatch();
  }

  // -------------------------------------------------------------- form options

  /** Cached dropdown choices, merged with the seed and your saved values. */
  formOptions(): BlsFormOptions {
    let cached = seededOptions();
    try {
      const file = this.optionsFile();
      if (fs.existsSync(file)) {
        cached = { ...cached, ...(JSON.parse(fs.readFileSync(file, 'utf8')) as BlsFormOptions) };
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not read cached form options');
    }
    return mergeOptions(cached, {
      visaType: this.config.bls.visaType,
      visaSubCategory: this.config.bls.visaSubCategory,
      applicantType: this.config.bls.applicantType,
    });
  }

  /**
   * Re-reads the dropdowns from the live BLS form. Needs an authenticated
   * session; it inspects the controls and selects nothing.
   */
  async refreshFormOptions(): Promise<{ ok: boolean; options: BlsFormOptions; reason?: string }> {
    if (this.worker.isRunning) {
      return { ok: false, options: this.formOptions(), reason: 'A check is already running.' };
    }

    this.log('Reading the visa lists from the BLS form', 'info');
    const result = await this.adapter.discoverFormOptions();

    if (!result.ok) {
      this.log(`Could not read the BLS lists: ${result.reason}`, 'warn');
      if (result.status === AvailabilityStatus.LOGIN_REQUIRED ||
          result.status === AvailabilityStatus.SESSION_EXPIRED ||
          result.status === AvailabilityStatus.CAPTCHA_REQUIRED) {
        this.session.setStatus('LOGIN_REQUIRED');
        this.patch({
          manualActionRequired: true,
          manualActionReason: result.reason,
          currentStatus: result.status,
        });
        this.startTakeoverWatch();
      }
      return { ok: false, options: this.formOptions(), reason: result.reason };
    }

    try {
      ensureDataDirs();
      fs.writeFileSync(this.optionsFile(), `${JSON.stringify(result.options, null, 2)}\n`, 'utf8');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not cache form options');
    }

    this.session.setStatus('AUTHENTICATED');
    this.log(
      `Visa lists updated from BLS (${result.options.visaTypes.length} type(s), ` +
        `${result.options.applicantTypes.length} appointment type(s))`,
      'success',
    );
    return { ok: true, options: this.formOptions() };
  }

  /**
   * Launches Chromium, turning a profile clash into a visible, explained pause
   * rather than an unhandled rejection. Two processes on one profile would log
   * each other out of BLS, so we stop instead.
   */
  private async launchBrowser(): Promise<boolean> {
    try {
      await this.browser.launch();
      return true;
    } catch (err) {
      const message = (err as Error).message;
      const clash = err instanceof ProfileInUseError;
      this.scheduler.cancel();
      this.patch({
        runState: 'PAUSED',
        currentStatus: AvailabilityStatus.ERROR,
        nextCheck: null,
        manualActionRequired: true,
        manualActionReason: message,
      });
      this.log(clash ? message : `Could not start the browser: ${message}`, 'error');
      log.error({ err: message }, 'browser launch failed');
      return false;
    }
  }

  private optionsFile(): string {
    return path.join(paths.state, 'bls-options.json');
  }

  async shutdown(): Promise<void> {
    this.stopTakeoverWatch();
    this.scheduler.cancel();
    this.worker.abort();
    this.persist();
    await this.browser.close();
  }

  // ------------------------------------------------------------- check loop

  private async runCheck(trigger: 'scheduled' | 'manual'): Promise<AvailabilityResult | null> {
    if (this.state.runState !== 'RUNNING' && trigger === 'scheduled') return null;

    // Never steal the page while you are working in it.
    if (trigger === 'scheduled' && this.browser.userActiveWithin(USER_ACTIVITY_GRACE_MS)) {
      this.log('You are using the browser, so this check is postponed', 'info');
      this.scheduleNext();
      return null;
    }

    this.log('Appointment check started', 'info');

    let result: AvailabilityResult | null;
    try {
      result = await this.worker.runOnce();
    } catch (err) {
      // The adapter converts its own failures into results; reaching here means
      // something outside it broke (browser crash, profile lock, …).
      result = null;
      const message = (err as Error).message;
      log.error({ err: message }, 'worker threw');
      this.recordError(message, BlsErrorCode.UNKNOWN);
      this.log(`Check failed: ${message}`, 'error');
      this.scheduleNext();
      return null;
    }

    if (!result) {
      this.log('Check skipped: another check was still running', 'warn');
      return null;
    }

    await this.applyResult(result);
    return result;
  }

  private async applyResult(result: AvailabilityResult): Promise<void> {
    const previous = this.state.previousStatus ?? this.state.currentStatus;
    const stats = rollDailyStats(this.state.stats);

    this.patch({
      lastCheck: result.checkedAt,
      lastAvailability: result,
      currentStatus: result.status,
      previousStatus: previous,
      sessionStatus: this.session.getStatus(),
      stats: { ...stats, checksToday: stats.checksToday + 1 },
    });

    this.log(`${describeStatus(result.status)}: ${result.message}`, levelFor(result.status));

    if (isAppointmentFoundTransition(previous, result.status) && result.available) {
      await this.handleAppointmentFound(result);
      return;
    }

    if (requiresManualAction(result.status)) {
      await this.handleManualAction(result);
      return;
    }

    if (isErrorStatus(result.status)) {
      await this.handleError(result);
      return;
    }

    // NOT_AVAILABLE, the normal, boring outcome.
    this.scheduler.recordSuccess();
    this.structureFailures = 0;
    this.patch({ errorCount: 0, currentStatus: result.status });
    this.scheduleNext();
  }

  private async handleAppointmentFound(result: AvailabilityResult): Promise<void> {
    this.scheduler.cancel();
    this.scheduler.recordSuccess();

    const stats = rollDailyStats(this.state.stats);
    this.patch({
      runState: 'STOPPED',
      currentStatus: AvailabilityStatus.AVAILABLE,
      nextCheck: null,
      errorCount: 0,
      stats: { ...stats, appointmentsFound: stats.appointmentsFound + 1 },
    });

    this.log(`APPOINTMENT_FOUND: ${describeSlots(result.appointments)}`, 'success');
    this.log('Monitoring stopped. The browser has been left open.', 'warn');

    // Browser stays open, nothing is booked, nothing is paid for.
    await this.browser.bringToFront();

    const outcome = await this.notifications.appointmentFound(result);
    this.recordNotification('appointment-found', outcome.telegram.ok);
    this.log(
      `Notifications sent (telegram=${outcome.telegram.ok} desktop=${outcome.desktop} sound=${outcome.sound})`,
      'info',
    );

    this.emit('appointment-found', result);
  }

  private async handleManualAction(result: AvailabilityResult): Promise<void> {
    this.scheduler.cancel();
    this.patch({
      runState: 'PAUSED',
      currentStatus: result.status,
      nextCheck: null,
      manualActionRequired: true,
      manualActionReason: result.message,
      sessionStatus:
        result.status === AvailabilityStatus.LOGIN_REQUIRED ||
        result.status === AvailabilityStatus.SESSION_EXPIRED
          ? 'LOGIN_REQUIRED'
          : this.session.getStatus(),
    });

    const needsLogin =
      result.status === AvailabilityStatus.LOGIN_REQUIRED ||
      result.status === AvailabilityStatus.SESSION_EXPIRED;

    this.log(
      needsLogin
        ? 'Session expired. The browser is on the login page, sign in there.'
        : `${describeStatus(result.status)}. Monitoring paused.`,
      'warn',
    );
    await this.browser.bringToFront();

    const outcome = await this.notifications.manualActionRequired(result);
    this.recordNotification(result.status.toLowerCase(), outcome.telegram.ok);
    this.log('Telegram notification sent', outcome.telegram.ok ? 'info' : 'warn');

    this.startTakeoverWatch();
    this.emit('manual-action-required', result);
  }

  /**
   * While you complete a CAPTCHA, a login or an OTP in the browser, this reads
   * the page that is ALREADY open every few seconds and resumes monitoring by
   * itself once the challenge is gone and the session looks authenticated.
   *
   * It only inspects the loaded DOM, no navigation, no extra requests to BLS,
   * and nothing on the verification itself is read, filled or clicked. The
   * challenge is still solved by you; this just notices when you are done.
   */
  private startTakeoverWatch(): void {
    this.stopTakeoverWatch();

    const INTERVAL_MS = 6000;
    this.takeoverWatch = setInterval(() => {
      void (async () => {
        if (!this.state.manualActionRequired) {
          this.stopTakeoverWatch();
          return;
        }

        const page = this.browser.currentPage();
        if (!page) return;

        try {
          const snapshot = await this.adapter.snapshot(page, null);
          if (detectHumanVerification(snapshot).detected) return;
          if (detectLoginRequired(snapshot).detected) return;
          if (!detectAuthenticated(snapshot).detected) return;

          this.stopTakeoverWatch();
          this.session.setStatus('AUTHENTICATED');
          this.log('Verification completed in the browser. Resuming automatically.', 'success');
          await this.resume();
        } catch {
          // The page is mid-navigation; try again on the next tick.
        }
      })();
    }, INTERVAL_MS);

    if (typeof this.takeoverWatch.unref === 'function') this.takeoverWatch.unref();
    this.log('Waiting for you to finish in the browser. Monitoring resumes by itself.', 'info');
  }

  private stopTakeoverWatch(): void {
    if (this.takeoverWatch) {
      clearInterval(this.takeoverWatch);
      this.takeoverWatch = null;
    }
  }

  private async handleError(result: AvailabilityResult): Promise<void> {
    this.recordError(result.message, result.errorCode ?? BlsErrorCode.UNKNOWN);

    const structureChange = result.errorCode === BlsErrorCode.WEBSITE_STRUCTURE_CHANGED;
    if (structureChange) this.structureFailures += 1;

    const blocking =
      result.errorCode === BlsErrorCode.LAGOS_SELECTION_ERROR ||
      result.errorCode === BlsErrorCode.VISA_CATEGORY_NOT_FOUND;

    // A misconfigured centre or category will not fix itself, stop asking BLS.
    if (blocking || this.structureFailures >= 3) {
      this.scheduler.cancel();
      this.patch({
        runState: 'PAUSED',
        nextCheck: null,
        manualActionRequired: true,
        manualActionReason: result.message,
      });
      this.log(`Monitoring paused. ${result.message}`, 'error');

      const outcome = await this.notifications.attentionRequired(
        structureChange ? 'WEBSITE STRUCTURE MAY HAVE CHANGED' : 'Configuration problem',
        structureChange
          ? 'The appointment page could not be interpreted safely. Monitoring is paused. Check the screenshot in data/screenshots/bls-spain-lagos/.'
          : result.message,
      );
      this.recordNotification('attention', outcome.telegram.ok);
      this.emit('attention-required', result);
      return;
    }

    this.scheduler.recordError();
    const range = computeIntervalRange(
      { minSeconds: this.config.bls.intervalMinSeconds, maxSeconds: this.config.bls.intervalMaxSeconds },
      this.scheduler.errors,
    );
    this.log(
      `Backoff: ${range.tier} (${Math.round(range.minSeconds / 60)}-${Math.round(range.maxSeconds / 60)} min)`,
      'warn',
    );
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.state.runState !== 'RUNNING') return;
    const delay = this.scheduler.schedule(() => {
      void this.runCheck('scheduled');
    });
    const nextCheck = new Date(Date.now() + delay).toISOString();
    this.patch({ nextCheck, currentStatus: this.state.currentStatus });
    this.log(`Next check in ${formatDuration(delay)}`, 'info');
  }

  // -------------------------------------------------------------- utilities

  private recordError(message: string, code: string): void {
    const stats = rollDailyStats(this.state.stats);
    this.patch({
      errorCount: this.state.errorCount + 1,
      lastError: { message, code, at: new Date().toISOString() },
      stats: { ...stats, errorsToday: stats.errorsToday + 1 },
    });
  }

  private recordNotification(channel: string, ok: boolean): void {
    this.patch({ lastNotification: { channel, at: new Date().toISOString(), ok } });
  }

  private log(message: string, level: MonitorEvent['level'] = 'info'): void {
    this.events.add(message, level);
    log[level === 'success' ? 'info' : level]({ message }, 'monitor event');
  }

  private patch(partial: Partial<MonitorState>): void {
    this.state = { ...this.state, ...partial, updatedAt: new Date().toISOString() };
    this.persist();
    this.emit('state', this.dashboardState());
  }

  private persist(): void {
    this.stateStore.save(this.state);
  }

  getState(): MonitorState {
    return this.state;
  }

  dashboardState(): DashboardState {
    const range = computeIntervalRange(
      {
        minSeconds: this.config.bls.intervalMinSeconds,
        maxSeconds: this.config.bls.intervalMaxSeconds,
      },
      this.scheduler.errors,
    );

    return {
      identity: {
        country: 'Spain',
        city: 'Lagos',
        applicationCountry: 'Nigeria',
        centre: 'Lagos',
        visaType: this.config.bls.visaType,
        visaSubCategory: this.config.bls.visaSubCategory,
        applicantType: this.config.bls.applicantType,
        memberCount: this.config.bls.memberCount,
      },
      runState: this.state.runState,
      status: this.state.currentStatus,
      statusLabel: describeStatus(this.state.currentStatus),
      availabilityMessage:
        this.state.lastAvailability?.message ?? 'No appointment currently detected',
      lastCheck: this.state.lastCheck,
      nextCheck: this.state.nextCheck,
      stats: this.state.stats,
      appointments: this.state.lastAvailability?.appointments ?? [],
      screenshotPath: this.state.lastAvailability?.screenshotPath ?? null,
      manualActionRequired: this.state.manualActionRequired,
      manualActionReason: this.state.manualActionReason,
      sessionStatus: this.session.getStatus(),
      notifications: this.notifications.status(),
      browserOpen: this.browser.isRunning(),
      browserInUse: this.browser.userActiveWithin(USER_ACTIVITY_GRACE_MS),
      errorCount: this.state.errorCount,
      lastError: this.state.lastError,
      intervalRange: range,
      preferences: {
        preferredDateFrom: this.config.bls.preferredDateFrom,
        preferredDateTo: this.config.bls.preferredDateTo,
        preferredTimeFrom: this.config.bls.preferredTimeFrom,
        preferredTimeTo: this.config.bls.preferredTimeTo,
        intervalMinSeconds: this.config.bls.intervalMinSeconds,
        intervalMaxSeconds: this.config.bls.intervalMaxSeconds,
      },
      manualCheckCooldownSeconds: this.config.bls.manualCheckCooldownSeconds,
      cooldownRemainingSeconds: this.cooldownRemainingSeconds(),
    };
  }

  getBrowser(): BrowserManager {
    return this.browser;
  }

  getSession(): SessionManager {
    return this.session;
  }

  getConfig(): AppConfig {
    return this.config;
  }

  /** Applies edited settings without restarting the process. */
  applyConfig(next: AppConfig): void {
    this.config = next;
    this.scheduler.updateOptions({
      minSeconds: next.bls.intervalMinSeconds,
      maxSeconds: next.bls.intervalMaxSeconds,
    });
    this.log('Configuration reloaded', 'info');
    this.emit('state', this.dashboardState());
  }
}

function levelFor(status: AvailabilityStatus): MonitorEvent['level'] {
  if (status === AvailabilityStatus.AVAILABLE) return 'success';
  if (requiresManualAction(status)) return 'warn';
  if (isErrorStatus(status)) return 'error';
  return 'info';
}

export { createInitialState };
