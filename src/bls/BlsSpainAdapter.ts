import type { Frame, Locator, Page, Response } from 'playwright';
import {
  APPLICANT_TYPE_CONTROLS,
  AVAILABLE_DAY_SELECTORS,
  BLS_URLS,
  BOOK_APPOINTMENT_LINKS,
  CONTINUE_CONTROLS,
  DISABLED_MARKERS,
  FORBIDDEN_ACTION_PATTERNS,
  FORBIDDEN_CENTRE_PATTERN,
  LAGOS_PATTERN,
  LOCATION_CONTROLS,
  LOGIN_URL_PATTERNS,
  MEMBER_COUNT_CONTROLS,
  SLOT_CONTAINERS,
  TIME_SLOT_SELECTORS,
  VISA_SUBCATEGORY_CONTROLS,
  VISA_TYPE_CONTROLS,
  type SelectorStrategy,
} from './BlsSelectors';
import {
  PROBE_SELECTORS,
  detectHumanVerification,
  detectLoginRequired,
  detectMfaPrompt,
  detectSiteError,
  evidenceText,
  redactQuery,
  type PageSnapshot,
} from './BlsPageDetector';
import { parseAvailability, type RawSlotCandidate } from './BlsAvailabilityParser';
import { seededOptions, type BlsFormOptions } from './BlsFormOptions';
import {
  ApplicantSelectionError,
  BlsError,
  BlsErrorCode,
  LagosSelectionError,
  LoginRequiredError,
  SiteUnavailableError,
  VisaCategoryNotFoundError,
  WebsiteStructureChangedError,
  toBlsError,
} from './errors';
import { AvailabilityStatus } from '../availability/AvailabilityState';
import {
  buildResult,
  describeSlots,
  filterSlots,
  type AvailabilityResult,
} from '../availability/AvailabilityResult';
import type { BlsConfig } from '../config/schema';
import type { BrowserManager } from '../browser/BrowserManager';
import type { SessionManager } from '../browser/SessionManager';
import { captureScreenshot } from '../utils/screenshots';
import { childLogger } from '../logging/logger';
import { sleep } from '../utils/time';
import { shortPauseMs } from '../utils/randomDelay';
import { withRetry } from '../utils/retry';

const log = childLogger('bls-adapter');

/**
 * Drives the public BLS Spain Nigeria booking portal as a normal visitor would.
 *
 * Hard boundaries, enforced throughout this file:
 *   - never solves, submits or reads a CAPTCHA / human-verification challenge
 *   - never enters credentials, OTP codes or MFA responses
 *   - never clicks a confirm / pay / finalise control (FORBIDDEN_ACTION_PATTERNS)
 *   - never calls an internal JSON endpoint directly; it uses the rendered UI
 *   - never selects any centre other than Lagos
 */
export class BlsSpainAdapter {
  /** Pages we have already attached the redirect listener to. */
  private readonly tracked = new WeakSet<Page>();
  /** Set when the portal sends the browser to its login route mid-navigation. */
  private loginRedirectSeen = false;

  constructor(
    private readonly browser: BrowserManager,
    private readonly session: SessionManager,
    private readonly config: BlsConfig,
  ) {}

  /**
   * One full availability check. Always resolves to an AvailabilityResult -
   * errors are translated into explicit error statuses, never into
   * "no appointments available".
   */
  /**
   * @param entryUrl Page to read instead of walking the funnel from the start.
   *   Set once you have passed BLS's verification by hand and landed on a slot
   *   page: re-walking the funnel would only hit the gate again.
   */
  async check(signal?: AbortSignal, entryUrl?: string | null): Promise<AvailabilityResult> {
    // Everything below is the monitor acting, so it must not be mistaken for
    // you using the browser.
    return this.browser.runOwned(() => this.runCheck(signal, entryUrl));
  }

  private async runCheck(signal?: AbortSignal, entryUrl?: string | null): Promise<AvailabilityResult> {
    const page = await this.browser.getPage();
    this.trackLoginRedirects(page);
    this.loginRedirectSeen = false;

    try {
      // Straight to the appointment area. A dead session bounces towards the
      // login route, which navigate() turns into LOGIN_REQUIRED; we never open
      // that route ourselves, because doing so would end a live session.
      const target = entryUrl ?? BLS_URLS.entry;
      const entryResponse = await this.navigate(page, target, signal);
      let snapshot = await this.snapshot(page, entryResponse?.status() ?? null);

      const gate = await this.evaluateGates(page, snapshot);
      if (gate) return gate;

      // A page reached past the verification already IS the appointment page,
      // so walking the funnel again would only take us back to the gate.
      if (!entryUrl) snapshot = await this.enterBookingFlow(page, snapshot);

      const gateAfterEntry = await this.evaluateGates(page, snapshot);
      if (gateAfterEntry) return gateAfterEntry;

      this.session.setStatus('AUTHENTICATED');

      await this.selectLagos(page, snapshot);
      await this.selectVisaType(page, snapshot);
      await this.selectVisaSubCategory(page, snapshot);
      await this.selectApplicantDetails(page, snapshot);
      await this.advanceToSlots(page);

      snapshot = await this.snapshot(page, null);
      const gateAfterFilters = await this.evaluateGates(page, snapshot);
      if (gateAfterFilters) return gateAfterFilters;

      await this.assertNotAbuja(page, snapshot);

      const candidates = await this.collectSlotCandidates(page);
      log.debug({ candidates: candidates.length }, 'slot candidates harvested');

      const parsed = parseAvailability({ snapshot, candidates });

      if (!parsed.ok) {
        throw new WebsiteStructureChangedError(parsed.message, {
          url: redactQuery(snapshot.url),
          title: snapshot.title,
          visibleText: parsed.evidence,
        });
      }

      if (parsed.status === AvailabilityStatus.NOT_AVAILABLE) {
        return buildResult({
          visaType: this.config.visaType,
          status: AvailabilityStatus.NOT_AVAILABLE,
          message: 'No appointments available',
          url: redactQuery(snapshot.url),
        });
      }

      const matching = filterSlots(parsed.slots, {
        preferredDateFrom: this.config.preferredDateFrom,
        preferredDateTo: this.config.preferredDateTo,
        preferredTimeFrom: this.config.preferredTimeFrom,
        preferredTimeTo: this.config.preferredTimeTo,
      });

      if (matching.length === 0) {
        // Slots exist, but none inside the configured window. This is a real
        // answer from the site, not a failure, so NOT_AVAILABLE is correct -
        // and the message makes the distinction visible.
        return buildResult({
          visaType: this.config.visaType,
          status: AvailabilityStatus.NOT_AVAILABLE,
          message: `Appointments exist but none match your date/time preferences (${describeSlots(parsed.slots)})`,
          url: redactQuery(snapshot.url),
        });
      }

      const screenshotPath = await captureScreenshot(page, 'appointment-found');

      return buildResult({
        visaType: this.config.visaType,
        status: AvailabilityStatus.AVAILABLE,
        message: `${matching.length} matching appointment slot${matching.length === 1 ? '' : 's'} for Lagos`,
        appointments: matching,
        screenshotPath,
        url: redactQuery(snapshot.url),
      });
    } catch (err) {
      return this.resultFromError(page, err);
    }
  }

  // ---------------------------------------------------------------- navigation

  /**
   * Watches navigation requests for the portal's login bounce.
   *
   * The redirect target is plain http and never completes, so the goto below
   * times out. Without this listener that would look like an outage; with it
   * we can report LOGIN_REQUIRED, which is what actually happened.
   */
  private trackLoginRedirects(page: Page): void {
    if (this.tracked.has(page)) return;
    this.tracked.add(page);
    page.on('request', (request) => {
      if (!request.isNavigationRequest()) return;
      const url = request.url();
      if (LOGIN_URL_PATTERNS.some((pattern) => pattern.test(url))) {
        this.loginRedirectSeen = true;
      }
    });
  }

  /**
   * Refuses to send a check to the login route. Visiting it while signed in
   * ends the session on this portal, so only the explicit sign-in action may
   * open it.
   */
  private assertNotLoginRoute(url: string): void {
    if (url.toLowerCase().includes('/account/login')) {
      throw new BlsError(
        BlsErrorCode.NAVIGATION_FAILED,
        'refusing to navigate a check to the login route; it would end the session',
      );
    }
  }

  private async navigate(page: Page, url: string, signal?: AbortSignal): Promise<Response | null> {
    this.assertNotLoginRoute(url);

    return withRetry(
      async () => {
        // The login bounce never completes (its target is plain http on a dead
        // port), so racing it means reporting LOGIN_REQUIRED in a second or two
        // instead of sitting through a 60s timeout.
        const bounced = this.waitForLoginBounce(page);
        try {
          const response = await Promise.race([
            page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }),
            bounced.promise,
          ]);
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {
            // Kendo widgets keep long-polling; a settled DOM is enough.
          });
          return response;
        } finally {
          bounced.dispose();
        }
      },
      {
        attempts: 3,
        baseDelayMs: 2500,
        maxDelayMs: 20_000,
        signal,
        // A login bounce is an answer, not a failure worth repeating. Everything
        // else, including Chromium's "interrupted by another navigation" race,
        // is worth one more try.
        shouldRetry: (error) => !(error instanceof LoginRequiredError),
        onAttemptFailed: (error, attempt) =>
          log.warn({ attempt, url: redactQuery(url), err: error.message }, 'navigation attempt failed'),
      },
    ).catch((err: unknown) => {
      if (err instanceof LoginRequiredError) throw err;
      const message = (err as Error).message;
      if (this.loginRedirectSeen) {
        throw new LoginRequiredError(
          'The portal redirected to its login page, so the session is not authenticated.',
          { url: redactQuery(url) },
        );
      }
      throw new SiteUnavailableError(`Could not load ${redactQuery(url)}: ${message}`);
    });
  }

  /** Rejects as soon as the portal tries to send us to its login page. */
  private waitForLoginBounce(page: Page): { promise: Promise<never>; dispose: () => void } {
    let onRequest: ((request: { isNavigationRequest(): boolean; url(): string }) => void) | null = null;

    const promise = new Promise<never>((_resolve, reject) => {
      onRequest = (request) => {
        if (!request.isNavigationRequest()) return;
        if (!LOGIN_URL_PATTERNS.some((pattern) => pattern.test(request.url()))) return;
        this.loginRedirectSeen = true;
        reject(
          new LoginRequiredError(
            'The portal redirected to its login page, so the session is not authenticated.',
            { url: redactQuery(request.url()) },
          ),
        );
      };
      page.on('request', onRequest as never);
    });

    // Nothing else awaits this promise, so swallow the rejection it may carry.
    promise.catch(() => undefined);

    return {
      promise,
      dispose: () => {
        if (onRequest) page.off('request', onRequest as never);
      },
    };
  }

  /**
   * Moves from wherever we landed into the appointment booking area.
   * Returns a fresh snapshot of the page we ended up on.
   */
  private async enterBookingFlow(page: Page, current: PageSnapshot): Promise<PageSnapshot> {
    // MyAppointments only lists bookings you already have, so the funnel is
    // entered through "Book New Appointment".
    const link = await this.resolveFirst(page, BOOK_APPOINTMENT_LINKS);
    if (link) {
      const label = ((await link.textContent().catch(() => '')) ?? '').trim();
      if (this.isForbiddenControl(label)) {
        log.warn({ label }, 'refusing to click a booking/payment control');
      } else {
        log.info({ label: label.slice(0, 60) }, 'entering booking flow');
        await link.click({ timeout: 15_000 }).catch((err: Error) => {
          log.warn({ err: err.message }, 'could not click booking entry link');
        });
        await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
        await sleep(shortPauseMs());
        return this.snapshot(page, null);
      }
    }
    return current;
  }

  /**
   * Nudges the wizard forward to wherever slots are rendered. Only generic
   * "continue / search" controls are used, and any control whose label looks
   * like a confirmation or payment step is skipped.
   */
  private async advanceToSlots(page: Page): Promise<void> {
    const control = await this.resolveFirst(page, CONTINUE_CONTROLS);
    if (!control) return;
    const label = ((await control.textContent().catch(() => '')) ?? '').trim() ||
      ((await control.getAttribute('value').catch(() => '')) ?? '').trim();

    if (this.isForbiddenControl(label)) {
      log.warn({ label }, 'refusing to click a confirmation/payment control');
      return;
    }

    log.debug({ label: label.slice(0, 40) }, 'advancing wizard');
    await control.click({ timeout: 15_000 }).catch((err: Error) => {
      log.debug({ err: err.message }, 'continue control not clickable');
    });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => undefined);
    await sleep(shortPauseMs(700, 900));
  }

  // -------------------------------------------------------------------- gates

  /**
   * Checks for conditions that must stop the run before any interaction:
   * site errors, human verification, MFA prompts and login walls.
   * Returns a finished result when one applies, otherwise null.
   */
  private async evaluateGates(page: Page, snapshot: PageSnapshot): Promise<AvailabilityResult | null> {
    const siteError = detectSiteError(snapshot);
    if (siteError.detected) {
      const screenshotPath = await captureScreenshot(page, 'site-error');
      return buildResult({
        visaType: this.config.visaType,
        status: AvailabilityStatus.SITE_UNAVAILABLE,
        message: `BLS website is not serving the appointment page (${siteError.reason})`,
        screenshotPath,
        errorCode: BlsErrorCode.SITE_UNAVAILABLE,
        url: redactQuery(snapshot.url),
      });
    }

    const verification = detectHumanVerification(snapshot);
    if (verification.detected) {
      // Detection only. We stop here and hand the browser to the user.
      const screenshotPath = await captureScreenshot(page, 'captcha');
      this.session.setStatus('UNKNOWN');
      return buildResult({
        visaType: this.config.visaType,
        status: AvailabilityStatus.CAPTCHA_REQUIRED,
        message: `Human verification required (${verification.reason})`,
        screenshotPath,
        url: redactQuery(snapshot.url),
      });
    }

    const mfa = detectMfaPrompt(snapshot);
    if (mfa.detected) {
      const screenshotPath = await captureScreenshot(page, 'unexpected-page');
      return buildResult({
        visaType: this.config.visaType,
        status: AvailabilityStatus.HUMAN_VERIFICATION_REQUIRED,
        message: `A one-time code / MFA step is required (${mfa.reason})`,
        screenshotPath,
        url: redactQuery(snapshot.url),
      });
    }

    const login = detectLoginRequired(snapshot);
    if (login.detected) {
      const status = login.sessionExpired
        ? AvailabilityStatus.SESSION_EXPIRED
        : AvailabilityStatus.LOGIN_REQUIRED;
      const screenshotPath = await captureScreenshot(
        page,
        login.sessionExpired ? 'session-expired' : 'login-required',
      );
      this.session.setStatus('LOGIN_REQUIRED');
      return buildResult({
        visaType: this.config.visaType,
        status,
        message: login.sessionExpired
          ? 'Your BLS session has expired. Log in again in the browser.'
          : 'BLS Spain Lagos requires login.',
        screenshotPath,
        url: redactQuery(snapshot.url),
      });
    }

    return null;
  }

  // ------------------------------------------------------- Lagos & visa type

  /**
   * Selects Lagos wherever a centre/location control exists, then verifies the
   * selection. If Lagos cannot be chosen we raise LAGOS_SELECTION_ERROR, we
   * never fall through to another centre.
   */
  private async selectLagos(page: Page, snapshot: PageSnapshot): Promise<void> {
    const control = await this.resolveFirst(page, LOCATION_CONTROLS);
    if (!control) {
      log.debug('no location control on this page; centre is implicit');
      return;
    }

    const options = await this.readOptions(page, control);
    const lagos = options.find((o) => LAGOS_PATTERN.test(o));

    if (options.length > 0 && !lagos) {
      throw new LagosSelectionError(
        `Lagos is not offered in the centre list. Options seen: ${options.slice(0, 12).join(' | ')}`,
        { url: redactQuery(snapshot.url), title: snapshot.title, visibleText: evidenceText(snapshot, 400) },
      );
    }

    const target = lagos ?? 'Lagos';
    const selected = await this.selectOptionByText(page, control, target);
    if (!selected) {
      throw new LagosSelectionError(`Could not select "${target}" in the centre control`, {
        url: redactQuery(snapshot.url),
        title: snapshot.title,
      });
    }

    await sleep(shortPauseMs());

    const chosen = await this.readControlValue(control);
    if (chosen && !LAGOS_PATTERN.test(chosen)) {
      throw new LagosSelectionError(
        `Centre control reads "${chosen}" after selecting Lagos. Refusing to continue.`,
        { url: redactQuery(snapshot.url), title: snapshot.title },
      );
    }
    log.info({ centre: chosen ?? target }, 'Lagos centre selected');
  }

  /** Guard against ever monitoring the wrong centre. */
  private async assertNotAbuja(page: Page, snapshot: PageSnapshot): Promise<void> {
    const control = await this.resolveFirst(page, LOCATION_CONTROLS);
    if (!control) return;
    const value = await this.readControlValue(control);
    if (value && FORBIDDEN_CENTRE_PATTERN.test(value)) {
      throw new LagosSelectionError(
        `Centre control reads "${value}". This application only monitors Lagos.`,
        { url: redactQuery(snapshot.url), title: snapshot.title },
      );
    }
  }

  /**
   * Selects the configured visa category by matching its text
   * case-insensitively. If it is not offered we stop; another category is
   * never substituted.
   */
  private async selectVisaType(page: Page, snapshot: PageSnapshot): Promise<void> {
    const control = await this.resolveFirst(page, VISA_TYPE_CONTROLS);
    if (!control) {
      log.debug('no visa category control on this page');
      return;
    }

    const options = await this.readOptions(page, control);
    const match = matchOption(options, this.config.visaType);

    if (options.length > 0 && !match) {
      throw new VisaCategoryNotFoundError(
        `Visa category "${this.config.visaType}" is not offered for Lagos`,
        options,
        { url: redactQuery(snapshot.url), title: snapshot.title },
      );
    }

    const target = match ?? this.config.visaType;
    const selected = await this.selectOptionByText(page, control, target);
    if (!selected) {
      throw new VisaCategoryNotFoundError(
        `Could not select visa category "${target}"`,
        options,
        { url: redactQuery(snapshot.url), title: snapshot.title },
      );
    }
    await sleep(shortPauseMs());
    log.info({ visaType: target }, 'visa category selected');
  }

  /**
   * Second-level category, only when the portal shows one. Absent control is
   * fine; a present control without the configured option is not.
   */
  private async selectVisaSubCategory(page: Page, snapshot: PageSnapshot): Promise<void> {
    const wanted = this.config.visaSubCategory?.trim();
    if (!wanted) return;

    const control = await this.resolveFirst(page, VISA_SUBCATEGORY_CONTROLS);
    if (!control) {
      log.debug('no visa sub-category control on this page');
      return;
    }

    const options = await this.readOptions(page, control);
    const match = matchOption(options, wanted);

    if (options.length > 0 && !match) {
      throw new VisaCategoryNotFoundError(
        `Visa sub-category "${wanted}" is not offered for Lagos`,
        options,
        { url: redactQuery(snapshot.url), title: snapshot.title },
      );
    }

    const selected = await this.selectOptionByText(page, control, match ?? wanted);
    if (!selected) {
      throw new VisaCategoryNotFoundError(`Could not select sub-category "${wanted}"`, options, {
        url: redactQuery(snapshot.url),
        title: snapshot.title,
      });
    }
    await sleep(shortPauseMs());
    log.info({ visaSubCategory: match ?? wanted }, 'visa sub-category selected');
  }

  /**
   * Individual / Family / Group and the number of applicants.
   *
   * BLS shows fewer (or different) slots for multi-applicant appointments, so
   * getting this wrong would mean watching the wrong availability. If a control
   * exists but the configured value cannot be set, we stop.
   */
  private async selectApplicantDetails(page: Page, snapshot: PageSnapshot): Promise<void> {
    const evidence = { url: redactQuery(snapshot.url), title: snapshot.title };
    const typeControl = await this.resolveFirst(page, APPLICANT_TYPE_CONTROLS);

    if (typeControl) {
      const options = await this.readOptions(page, typeControl);
      const match = matchOption(options, this.config.applicantType);
      if (options.length > 0 && !match) {
        throw new ApplicantSelectionError(
          `Appointment type "${this.config.applicantType}" is not offered. Options seen: ${options
            .slice(0, 10)
            .join(' | ')}`,
          evidence,
        );
      }
      const selected = await this.selectOptionByText(
        page,
        typeControl,
        match ?? this.config.applicantType,
      );
      if (!selected) {
        throw new ApplicantSelectionError(
          `Could not select appointment type "${this.config.applicantType}"`,
          evidence,
        );
      }
      await sleep(shortPauseMs());
      log.info({ applicantType: match ?? this.config.applicantType }, 'appointment type selected');
    }

    // The member count only appears for Family / Group on most BLS tenants.
    if (this.config.memberCount <= 1) return;

    const countControl = await this.resolveFirst(page, MEMBER_COUNT_CONTROLS);
    if (!countControl) {
      log.debug({ memberCount: this.config.memberCount }, 'no member-count control on this page');
      return;
    }

    const wanted = String(this.config.memberCount);
    const tag = (await countControl.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')) as string;

    if (tag === 'input') {
      try {
        await countControl.fill(wanted);
      } catch (err) {
        throw new ApplicantSelectionError(
          `Could not set the number of applicants to ${wanted}: ${(err as Error).message}`,
          evidence,
        );
      }
    } else {
      const options = await this.readOptions(page, countControl);
      const match = options.find((o) => o.trim() === wanted) ?? matchOption(options, wanted);
      if (options.length > 0 && !match) {
        throw new ApplicantSelectionError(
          `${wanted} applicants is not offered (options: ${options.slice(0, 10).join(' | ')})`,
          evidence,
        );
      }
      const selected = await this.selectOptionByText(page, countControl, match ?? wanted);
      if (!selected) {
        throw new ApplicantSelectionError(
          `Could not select ${wanted} applicants`,
          evidence,
        );
      }
    }

    await sleep(shortPauseMs());
    log.info({ memberCount: this.config.memberCount }, 'applicant count set');
  }

  // ----------------------------------------------------------- slot harvest

  /**
   * Harvests every element that could represent a bookable slot.
   * Runs entirely in the page (no network calls of its own) and returns raw
   * strings; interpretation happens in BlsAvailabilityParser.
   */
  private async collectSlotCandidates(page: Page): Promise<RawSlotCandidate[]> {
    const containerSelectors = SLOT_CONTAINERS.flatMap((s) =>
      s.kind === 'css' ? [s.selector] : [],
    );

    return page.evaluate(
      ({ daySelectors, timeSelectors, disabledMarkers, containerSelectors: containers }) => {
        const MONTHS: Record<string, number> = {
          jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
          jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
        };

        const isVisible = (el: Element): boolean => {
          const node = el as HTMLElement;
          if (!node.getClientRects || node.getClientRects().length === 0) return false;
          const style = window.getComputedStyle(node);
          return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        };

        const isDisabled = (el: Element): boolean => {
          const node = el as HTMLElement;
          if (node.hasAttribute('disabled') || node.getAttribute('aria-disabled') === 'true') return true;
          const cls = (node.className && String(node.className)) || '';
          return disabledMarkers.some((marker) => cls.toLowerCase().includes(marker.toLowerCase()));
        };

        /** Finds "October 2026" style context for a bare day number. */
        const monthContext = (el: Element): { month: number; year: number } | null => {
          let node: Element | null = el;
          for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
            const headerText = Array.from(
              node.querySelectorAll(
                '.k-header, .k-calendar-title, .flatpickr-current-month, caption, thead, [class*="header" i], [class*="title" i], select[class*="month" i]',
              ),
            )
              .map((h) => (h as HTMLElement).innerText || h.textContent || '')
              .join(' ');
            const combined = `${headerText} ${(node as HTMLElement).getAttribute?.('aria-label') ?? ''}`;
            const m = combined.match(
              /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{4})\b/i,
            );
            if (m) return { month: MONTHS[m[1]!.toLowerCase()]!, year: Number(m[2]) };
            const numeric = combined.match(/\b(\d{4})[-/](\d{1,2})\b/);
            if (numeric) return { month: Number(numeric[2]), year: Number(numeric[1]) };
          }
          return null;
        };

        const dateFromAttributes = (el: Element): string | null => {
          const attrs = [
            'data-date', 'data-value', 'data-day', 'data-appointment-date',
            'aria-label', 'title', 'value', 'datetime',
          ];
          for (const attr of attrs) {
            const value = el.getAttribute(attr);
            if (value && /\d/.test(value)) return value;
          }
          const time = el.querySelector('time[datetime]');
          if (time) return time.getAttribute('datetime');
          return null;
        };

        const results: {
          date?: string | null;
          time?: string | null;
          label?: string | null;
          source?: string;
        }[] = [];

        const pushCandidate = (el: Element, source: string): void => {
          if (!isVisible(el) || isDisabled(el)) return;
          const text = ((el as HTMLElement).innerText || el.textContent || '').trim();
          let date = dateFromAttributes(el);

          if (!date) {
            const bareDay = text.match(/^\s*(\d{1,2})\s*$/);
            if (bareDay) {
              const ctx = monthContext(el);
              if (ctx) {
                date = `${ctx.year}-${String(ctx.month).padStart(2, '0')}-${String(
                  Number(bareDay[1]),
                ).padStart(2, '0')}`;
              }
            } else if (/\d/.test(text)) {
              date = text;
            }
          }

          if (!date) return;

          const timeMatch = text.match(
            /\b(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*[ap]\.?m\.?)?\b|\b\d{1,2}\s*[ap]\.?m\.?\b/i,
          );

          results.push({
            date,
            time: timeMatch ? timeMatch[0] : null,
            label: text.slice(0, 160),
            source,
          });
        };

        for (const selector of daySelectors) {
          let nodes: Element[] = [];
          try {
            nodes = Array.from(document.querySelectorAll(selector));
          } catch {
            continue; // an invalid selector must not abort the whole harvest
          }
          for (const node of nodes.slice(0, 200)) pushCandidate(node, selector);
        }

        for (const selector of timeSelectors) {
          let nodes: Element[] = [];
          try {
            nodes = Array.from(document.querySelectorAll(selector));
          } catch {
            continue;
          }
          for (const node of nodes.slice(0, 200)) {
            if (!isVisible(node) || isDisabled(node)) continue;
            const text = ((node as HTMLElement).innerText || node.textContent || '').trim();
            const timeMatch = text.match(
              /\b(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*[ap]\.?m\.?)?\b|\b\d{1,2}\s*[ap]\.?m\.?\b/i,
            );
            if (!timeMatch) continue;
            const dateAttr = dateFromAttributes(node);
            if (!dateAttr) continue;
            results.push({
              date: dateAttr,
              time: timeMatch[0],
              label: text.slice(0, 160),
              source: selector,
            });
          }
        }

        // Rows inside a slot table: "14/10/2026  09:30  Lagos"
        for (const containerSelector of containers) {
          let containerNodes: Element[] = [];
          try {
            containerNodes = Array.from(document.querySelectorAll(containerSelector));
          } catch {
            continue;
          }
          for (const container of containerNodes.slice(0, 10)) {
            if (!isVisible(container)) continue;
            const rows = Array.from(container.querySelectorAll('tr')).slice(0, 100);
            for (const row of rows) {
              if (!isVisible(row) || isDisabled(row)) continue;
              const text = ((row as HTMLElement).innerText || row.textContent || '').trim();
              const dateMatch = text.match(
                /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{2,4})\b/,
              );
              if (!dateMatch) continue;
              const timeMatch = text.match(
                /\b(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*[ap]\.?m\.?)?\b|\b\d{1,2}\s*[ap]\.?m\.?\b/i,
              );
              results.push({
                date: dateMatch[0],
                time: timeMatch ? timeMatch[0] : null,
                label: text.slice(0, 160),
                source: `${containerSelector} tr`,
              });
            }
          }
        }

        return results;
      },
      {
        daySelectors: AVAILABLE_DAY_SELECTORS,
        timeSelectors: TIME_SLOT_SELECTORS,
        disabledMarkers: DISABLED_MARKERS,
        containerSelectors,
      },
    );
  }

  /**
   * Reads the option lists the live BLS form offers, so the dashboard can show
   * real dropdowns instead of free text.
   *
   * Read-only: it opens the booking page and inspects the controls. Nothing is
   * selected, submitted or booked. Requires an authenticated session; without
   * one it reports why and the UI falls back to the seeded lists.
   */
  async discoverFormOptions(): Promise<
    { ok: true; options: BlsFormOptions } | { ok: false; reason: string; status: AvailabilityStatus }
  > {
    return this.browser.runOwned(() => this.runDiscoverFormOptions());
  }

  private async runDiscoverFormOptions(): Promise<
    { ok: true; options: BlsFormOptions } | { ok: false; reason: string; status: AvailabilityStatus }
  > {
    const page = await this.browser.getPage();
    this.trackLoginRedirects(page);
    this.loginRedirectSeen = false;

    try {
      const entry = await this.navigate(page, BLS_URLS.entry);
      let snapshot = await this.snapshot(page, entry?.status() ?? null);

      const gate = await this.evaluateGates(page, snapshot);
      if (gate) return { ok: false, reason: gate.message, status: gate.status };

      snapshot = await this.enterBookingFlow(page, snapshot);

      const afterEntry = await this.evaluateGates(page, snapshot);
      if (afterEntry) return { ok: false, reason: afterEntry.message, status: afterEntry.status };

      const options = seededOptions();
      options.fromLiveForm = false;

      const locationControl = await this.resolveFirst(page, LOCATION_CONTROLS);
      if (locationControl) {
        const values = await this.readOptions(page, locationControl);
        if (values.length > 0) {
          options.locations = values;
          options.fromLiveForm = true;
        }
      }

      const visaControl = await this.resolveFirst(page, VISA_TYPE_CONTROLS);
      if (visaControl) {
        const values = await this.readOptions(page, visaControl);
        if (values.length > 0) {
          options.visaTypes = values;
          options.fromLiveForm = true;
        }
      }

      const subControl = await this.resolveFirst(page, VISA_SUBCATEGORY_CONTROLS);
      if (subControl) {
        const values = await this.readOptions(page, subControl);
        if (values.length > 0) {
          // Without selecting a type we cannot tell which type these belong to,
          // so they are offered under every discovered type.
          options.subCategories = Object.fromEntries(
            options.visaTypes.map((type) => [type, values]),
          );
          options.fromLiveForm = true;
        }
      }

      const applicantControl = await this.resolveFirst(page, APPLICANT_TYPE_CONTROLS);
      if (applicantControl) {
        const values = await this.readOptions(page, applicantControl);
        if (values.length > 0) {
          options.applicantTypes = values;
          options.fromLiveForm = true;
        }
      }

      if (!options.fromLiveForm) {
        return {
          ok: false,
          reason: 'The booking page did not expose any dropdowns to read.',
          status: AvailabilityStatus.ERROR,
        };
      }

      options.discoveredAt = new Date().toISOString();
      log.info(
        {
          visaTypes: options.visaTypes.length,
          locations: options.locations.length,
          applicantTypes: options.applicantTypes.length,
        },
        'form options discovered',
      );
      return { ok: true, options };
    } catch (err) {
      const error = toBlsError(err);
      return { ok: false, reason: error.message, status: AvailabilityStatus.ERROR };
    }
  }

  // ------------------------------------------------------------- page access

  /** Serialises the current page into the shape the detectors understand. */
  async snapshot(page: Page, httpStatus: number | null): Promise<PageSnapshot> {
    const data = await page.evaluate((probes: string[]) => {
      const isVisible = (el: Element): boolean => {
        const node = el as HTMLElement;
        if (node.tagName === 'IFRAME') return true; // measured via its own box below
        if (!node.getClientRects || node.getClientRects().length === 0) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const visibleMatches: string[] = [];
      for (const selector of probes) {
        try {
          const nodes = Array.from(document.querySelectorAll(selector));
          if (nodes.some((node) => isVisible(node))) visibleMatches.push(selector);
        } catch {
          // Ignore selectors this browser cannot parse.
        }
      }

      const iframes = Array.from(document.querySelectorAll('iframe')).map((frame) => ({
        src: frame.getAttribute('src') ?? '',
        title: frame.getAttribute('title') ?? '',
      }));

      return {
        url: location.href,
        title: document.title,
        visibleText: (document.body?.innerText ?? '').slice(0, 20000),
        visibleMatches,
        iframes,
      };
    }, PROBE_SELECTORS);

    return { ...data, httpStatus };
  }

  // --------------------------------------------------------- selector engine

  /**
   * Tries each strategy in order and returns the first visible match.
   * Callers treat a null return as "this control is not on the page", and a
   * missing *required* control becomes WebsiteStructureChangedError.
   */
  private async resolveFirst(
    scope: Page | Frame,
    strategies: SelectorStrategy[],
  ): Promise<Locator | null> {
    for (const strategy of strategies) {
      const locator = this.toLocator(scope, strategy);
      if (!locator) continue;
      try {
        const first = locator.first();
        if (await first.isVisible({ timeout: 1500 })) return first;
      } catch {
        // Strategy missed; fall through to the next fallback.
      }
    }
    return null;
  }

  private toLocator(scope: Page | Frame, strategy: SelectorStrategy): Locator | null {
    switch (strategy.kind) {
      case 'role':
        return scope.getByRole(strategy.role as never, {
          ...(strategy.name ? { name: strategy.name } : {}),
          ...(strategy.exact !== undefined ? { exact: strategy.exact } : {}),
        });
      case 'label':
        return scope.getByLabel(strategy.text);
      case 'placeholder':
        return scope.getByPlaceholder(strategy.text);
      case 'text':
        return scope.getByText(strategy.text);
      case 'css':
        return scope.locator(strategy.selector);
      default:
        return null;
    }
  }

  /** Reads the option labels of a native select or a Kendo-style dropdown. */
  private async readOptions(page: Page, control: Locator): Promise<string[]> {
    const tag = (await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')) as string;

    if (tag === 'select') {
      return control
        .evaluate((el) =>
          Array.from((el as HTMLSelectElement).options)
            .map((o) => (o.textContent ?? '').trim())
            .filter(Boolean),
        )
        .catch(() => []);
    }

    // Kendo / custom widget: open it, read the popup list, close it again.
    try {
      await control.click({ timeout: 8000 });
      await sleep(shortPauseMs(250, 400));
      const options = await page
        .locator('[role="option"], .k-list-item, .k-item, li[role="option"]')
        .allTextContents();
      await page.keyboard.press('Escape').catch(() => undefined);
      return options.map((o) => o.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Selects an option by visible text. Returns false when nothing matched. */
  private async selectOptionByText(page: Page, control: Locator, text: string): Promise<boolean> {
    const tag = (await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => '')) as string;

    if (tag === 'select') {
      try {
        await control.selectOption({ label: text });
        return true;
      } catch {
        try {
          const value = await control.evaluate((el, wanted: string) => {
            const option = Array.from((el as HTMLSelectElement).options).find((o) =>
              (o.textContent ?? '').trim().toLowerCase().includes(wanted.toLowerCase()),
            );
            return option ? option.value : null;
          }, text);
          if (!value) return false;
          await control.selectOption(value);
          return true;
        } catch {
          return false;
        }
      }
    }

    try {
      await control.click({ timeout: 8000 });
      await sleep(shortPauseMs(250, 400));
      const option = page
        .locator('[role="option"], .k-list-item, .k-item, li[role="option"]')
        .filter({ hasText: new RegExp(escapeRegExp(text), 'i') })
        .first();
      if (!(await option.isVisible({ timeout: 4000 }).catch(() => false))) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return false;
      }
      await option.click({ timeout: 8000 });
      return true;
    } catch {
      return false;
    }
  }

  private async readControlValue(control: Locator): Promise<string | null> {
    try {
      return await control.evaluate((el) => {
        const node = el as HTMLElement;
        if (node.tagName.toLowerCase() === 'select') {
          const select = node as unknown as HTMLSelectElement;
          return (select.selectedOptions[0]?.textContent ?? '').trim();
        }
        const input = node.querySelector('input');
        if (input) return (input as HTMLInputElement).value.trim();
        return (node.innerText || node.textContent || '').trim();
      });
    } catch {
      return null;
    }
  }

  /** Refuses to touch anything that looks like a confirmation or payment step. */
  private isForbiddenControl(label: string | null | undefined): boolean {
    if (!label) return false;
    return FORBIDDEN_ACTION_PATTERNS.some((pattern) => pattern.test(label));
  }

  // ------------------------------------------------------------ error mapping

  /**
   * Maps a thrown error to an explicit status. There is deliberately no branch
   * that produces NOT_AVAILABLE here.
   */
  private async resultFromError(page: Page | null, err: unknown): Promise<AvailabilityResult> {
    const error = toBlsError(err);

    if (error instanceof LoginRequiredError) {
      this.session.setStatus('LOGIN_REQUIRED');
      // No screenshot here on purpose: this path fires while the page is still
      // stuck on the portal's dead http redirect, so a capture would just burn
      // its 30s timeout on a blank frame. The login page itself is captured by
      // evaluateGates, which does have something to show.
      log.warn({ code: error.code }, 'login required (redirected to the login route)');
      await this.parkOnLoginPage(page);
      return buildResult({
        visaType: this.config.visaType,
        status: AvailabilityStatus.LOGIN_REQUIRED,
        message: 'BLS Spain Lagos requires login.',
        errorCode: error.code,
        url: error.evidence.url ?? null,
      });
    }

    const screenshotEvent =
      error instanceof WebsiteStructureChangedError
        ? 'structure-changed'
        : error instanceof LagosSelectionError
          ? 'lagos-selection-error'
          : error instanceof VisaCategoryNotFoundError
            ? 'visa-category-not-found'
            : error instanceof SiteUnavailableError
              ? 'site-error'
              : 'unexpected-page';

    const screenshotPath = await captureScreenshot(page, screenshotEvent);

    const status =
      error instanceof SiteUnavailableError
        ? AvailabilityStatus.SITE_UNAVAILABLE
        : AvailabilityStatus.ERROR;

    log.error(
      {
        code: error.code,
        err: error.message,
        url: error.evidence.url ?? null,
        title: error.evidence.title ?? null,
      },
      'check failed',
    );

    if (error instanceof WebsiteStructureChangedError && error.evidence.visibleText) {
      log.error({ excerpt: error.evidence.visibleText.slice(0, 600) }, 'structure change evidence');
    }

    return buildResult({
      visaType: this.config.visaType,
      status,
      message: this.userMessageFor(error),
      screenshotPath,
      errorCode: error.code,
      url: error.evidence.url ?? null,
    });
  }

  /**
   * Leaves the browser somewhere the user can actually act.
   *
   * BLS answers an expired session with a 302 to a PLAIN-HTTP login URL whose
   * port does not respond, so Chromium ends up on ERR_CONNECTION_TIMED_OUT with
   * no way to sign in. Replacing that with the real https login page turns a
   * dead end into the form you need.
   *
   * This is the one place that navigates to the login route deliberately, and
   * it is safe precisely because we only get here after proving the session is
   * already gone: there is no live session left to end.
   */
  private async parkOnLoginPage(page: Page | null): Promise<void> {
    if (!page || page.isClosed()) return;
    try {
      await page.goto(BLS_URLS.login, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      log.info('browser parked on the login page for manual sign-in');
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'could not open the login page');
    }
  }

  private userMessageFor(error: BlsError): string {
    switch (error.code) {
      case BlsErrorCode.WEBSITE_STRUCTURE_CHANGED:
        return `WEBSITE STRUCTURE MAY HAVE CHANGED. ${error.message}`;
      case BlsErrorCode.LAGOS_SELECTION_ERROR:
        return `LAGOS_SELECTION_ERROR: ${error.message}`;
      case BlsErrorCode.VISA_CATEGORY_NOT_FOUND:
        return `VISA_CATEGORY_NOT_FOUND: ${error.message}`;
      case BlsErrorCode.APPLICANT_SELECTION_ERROR:
        return `APPLICANT_SELECTION_ERROR: ${error.message}`;
      case BlsErrorCode.SITE_UNAVAILABLE:
        return `BLS website unavailable. ${error.message}`;
      default:
        return `Check failed. ${error.message}`;
    }
  }
}

/** Exact, then substring, then all-words match, never a fuzzy guess. */
function matchOption(options: string[], wanted: string): string | undefined {
  const needle = wanted.trim().toLowerCase();
  return (
    options.find((o) => o.trim().toLowerCase() === needle) ??
    options.find((o) => o.toLowerCase().includes(needle)) ??
    options.find((o) => needle.split(/\s+/).every((word) => o.toLowerCase().includes(word)))
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
