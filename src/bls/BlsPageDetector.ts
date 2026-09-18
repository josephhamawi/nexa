import {
  APPOINTMENT_URL_PATTERNS,
  AUTHENTICATED_MARKERS,
  CAPTCHA_IFRAME_SRC_PATTERNS,
  CAPTCHA_SELECTORS,
  CAPTCHA_TEXT_PATTERNS,
  HAS_APPOINTMENT_PATTERNS,
  LOGIN_PAGE_MARKERS,
  LOGIN_TEXT_PATTERNS,
  LOGIN_URL_PATTERNS,
  MFA_TEXT_PATTERNS,
  NO_APPOINTMENT_PATTERNS,
  SESSION_EXPIRED_PATTERNS,
  SITE_ERROR_PATTERNS,
  type SelectorStrategy,
} from './BlsSelectors';

/**
 * A flattened, serialisable view of a page.
 *
 * Detection works on snapshots rather than on a live Playwright Page so the
 * same logic runs unchanged in unit tests against HTML fixtures.
 */
export interface PageSnapshot {
  url: string;
  title: string;
  /** Visible text only, hidden inputs and script contents are excluded. */
  visibleText: string;
  /** CSS selectors (from PROBE_SELECTORS) that matched at least one VISIBLE element. */
  visibleMatches: string[];
  iframes: { src: string; title: string }[];
  /** HTTP status of the main document, when known. */
  httpStatus?: number | null;
}

function cssOf(strategies: SelectorStrategy[]): string[] {
  return strategies.flatMap((s) => (s.kind === 'css' ? [s.selector] : []));
}

/** The selector list evaluated against every page we snapshot. */
export const PROBE_SELECTORS: string[] = Array.from(
  new Set([
    ...cssOf(CAPTCHA_SELECTORS),
    ...cssOf(LOGIN_PAGE_MARKERS),
    ...cssOf(AUTHENTICATED_MARKERS),
    'a[href*="logout" i]',
    'input[type="password"]',
    'form[action*="loginsubmit" i]',
    'input[name^="UserId"]',
    'iframe',
  ]),
);

const CAPTCHA_CSS = new Set(cssOf(CAPTCHA_SELECTORS));
const LOGIN_CSS = new Set(cssOf(LOGIN_PAGE_MARKERS));
const AUTH_CSS = new Set(cssOf(AUTHENTICATED_MARKERS));

function anyMatch(patterns: RegExp[], text: string): RegExp | null {
  for (const pattern of patterns) {
    if (pattern.test(text)) return pattern;
  }
  return null;
}

export interface Detection {
  detected: boolean;
  reason: string;
}

const NEGATIVE: Detection = { detected: false, reason: '' };

/**
 * Human-verification detection.
 *
 * DETECTION ONLY. Nothing here clicks, focuses, submits, reads tokens from, or
 * otherwise interacts with a challenge. A positive result stops the monitor and
 * hands the browser to the user.
 */
export function detectHumanVerification(snapshot: PageSnapshot): Detection {
  for (const frame of snapshot.iframes) {
    const haystack = `${frame.src} ${frame.title}`;
    const hit = anyMatch(CAPTCHA_IFRAME_SRC_PATTERNS, haystack);
    if (hit) {
      return { detected: true, reason: `verification iframe matched ${hit} (src=${redactQuery(frame.src)})` };
    }
  }

  const matchedSelector = snapshot.visibleMatches.find((sel) => CAPTCHA_CSS.has(sel));
  if (matchedSelector) {
    return { detected: true, reason: `visible verification element matched "${matchedSelector}"` };
  }

  const textHit = anyMatch(CAPTCHA_TEXT_PATTERNS, snapshot.visibleText);
  if (textHit) {
    return { detected: true, reason: `page text matched ${textHit}` };
  }

  const titleHit = anyMatch(CAPTCHA_TEXT_PATTERNS, snapshot.title);
  if (titleHit) {
    return { detected: true, reason: `page title matched ${titleHit}` };
  }

  return NEGATIVE;
}

/** MFA / OTP prompts. Also detection only, never automated. */
export function detectMfaPrompt(snapshot: PageSnapshot): Detection {
  const hit = anyMatch(MFA_TEXT_PATTERNS, snapshot.visibleText);
  return hit ? { detected: true, reason: `page text matched ${hit}` } : NEGATIVE;
}

export interface LoginDetection extends Detection {
  sessionExpired: boolean;
}

/**
 * Login detection.
 *
 * Positive signals (a visible password field, a login form action, a bounce to
 * /account/login) win over the presence of the word "login" in a navbar, which
 * is why authenticated markers are checked first.
 */
export function detectLoginRequired(snapshot: PageSnapshot): LoginDetection {
  const sessionExpiredHit = anyMatch(SESSION_EXPIRED_PATTERNS, snapshot.visibleText);

  const hasAuthMarker = snapshot.visibleMatches.some((sel) => AUTH_CSS.has(sel));
  const hasLogoutText = /\blog\s?out\b|\bsign\s?out\b/i.test(snapshot.visibleText);

  const urlHit = anyMatch(LOGIN_URL_PATTERNS, snapshot.url);
  if (urlHit) {
    return {
      detected: true,
      sessionExpired: Boolean(sessionExpiredHit),
      reason: `url matched ${urlHit} (${snapshot.url})`,
    };
  }

  const loginSelector = snapshot.visibleMatches.find((sel) => LOGIN_CSS.has(sel));
  if (loginSelector) {
    return {
      detected: true,
      sessionExpired: Boolean(sessionExpiredHit),
      reason: `visible login control matched "${loginSelector}"`,
    };
  }

  if (sessionExpiredHit) {
    return { detected: true, sessionExpired: true, reason: `page text matched ${sessionExpiredHit}` };
  }

  if (hasAuthMarker || hasLogoutText) {
    return { detected: false, sessionExpired: false, reason: '' };
  }

  const textHit = anyMatch(LOGIN_TEXT_PATTERNS, snapshot.visibleText);
  if (textHit && !isAppointmentUrl(snapshot.url)) {
    return { detected: true, sessionExpired: false, reason: `page text matched ${textHit}` };
  }

  return { detected: false, sessionExpired: false, reason: '' };
}

export function detectAuthenticated(snapshot: PageSnapshot): Detection {
  const login = detectLoginRequired(snapshot);
  if (login.detected) return NEGATIVE;
  const marker = snapshot.visibleMatches.find((sel) => AUTH_CSS.has(sel));
  if (marker) return { detected: true, reason: `authenticated marker "${marker}"` };
  if (/\blog\s?out\b|\bsign\s?out\b|\bmy appointments\b/i.test(snapshot.visibleText)) {
    return { detected: true, reason: 'authenticated text marker' };
  }
  return NEGATIVE;
}

export function detectSiteError(snapshot: PageSnapshot): Detection {
  if (typeof snapshot.httpStatus === 'number' && snapshot.httpStatus >= 500) {
    return { detected: true, reason: `HTTP ${snapshot.httpStatus}` };
  }
  if (snapshot.httpStatus === 429) {
    return { detected: true, reason: 'HTTP 429 (rate limited by BLS)' };
  }
  const hit = anyMatch(SITE_ERROR_PATTERNS, snapshot.visibleText);
  if (hit) return { detected: true, reason: `page text matched ${hit}` };
  return NEGATIVE;
}

/**
 * Explicit "no appointments" wording.
 *
 * This is the ONLY route to a NOT_AVAILABLE result. An empty-looking page with
 * no such wording is a structure change, not an answer.
 */
export function detectNoAppointments(snapshot: PageSnapshot): Detection {
  const hit = anyMatch(NO_APPOINTMENT_PATTERNS, snapshot.visibleText);
  return hit ? { detected: true, reason: `page text matched ${hit}` } : NEGATIVE;
}

export function detectAppointmentWording(snapshot: PageSnapshot): Detection {
  const hit = anyMatch(HAS_APPOINTMENT_PATTERNS, snapshot.visibleText);
  return hit ? { detected: true, reason: `page text matched ${hit}` } : NEGATIVE;
}

export function isAppointmentUrl(url: string): boolean {
  if (anyMatch(LOGIN_URL_PATTERNS, url)) return false;
  return Boolean(anyMatch(APPOINTMENT_URL_PATTERNS, url));
}

/** Strips query strings so captcha/session identifiers never reach the logs. */
export function redactQuery(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : `${url.slice(0, cut)}?[redacted]`;
}

/** Bounded excerpt of page text, safe to store as structure-change evidence. */
export function evidenceText(snapshot: PageSnapshot, limit = 1200): string {
  return snapshot.visibleText.replace(/\s+/g, ' ').trim().slice(0, limit);
}
