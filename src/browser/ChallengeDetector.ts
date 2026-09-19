import type { Page } from 'playwright';

/**
 * Detects when a page is asking for a human rather than a program.
 *
 * DETECTION ONLY. Nothing here reads, fills, clicks, submits or otherwise
 * interacts with a challenge. A positive result stops the workflow and hands
 * the browser to the user, which is the entire strategy: Nexa never tries to
 * look like a person, it asks for one.
 */

export interface PageSnapshot {
  url: string;
  title: string;
  visibleText: string;
  /** Probe selectors that matched at least one VISIBLE element. */
  visibleMatches: string[];
  iframes: { src: string; title: string }[];
  httpStatus?: number | null;
}

export const CHALLENGE_SELECTORS = [
  'iframe[src*="recaptcha" i]',
  'iframe[src*="hcaptcha" i]',
  'iframe[src*="turnstile" i]',
  'iframe[src*="challenges.cloudflare.com" i]',
  'iframe[src*="captcha" i]',
  'iframe[title*="captcha" i]',
  'iframe[title*="challenge" i]',
  '.g-recaptcha',
  '.h-captcha',
  '.cf-turnstile',
  '#cf-challenge-running',
  '#challenge-form',
  '[data-sitekey]',
  '[class*="captcha" i]',
  '[id*="captcha" i]:not(script)',
];

export const LOGIN_SELECTORS = [
  'input[type="password"]',
  'form[action*="login" i]',
  'form[action*="signin" i]',
  'button[type="submit"][name*="login" i]',
];

export const AUTHENTICATED_SELECTORS = [
  'a[href*="logout" i]',
  'a[href*="signout" i]',
  '[onclick*="logout" i]',
];

export const PROBE_SELECTORS: string[] = Array.from(
  new Set([...CHALLENGE_SELECTORS, ...LOGIN_SELECTORS, ...AUTHENTICATED_SELECTORS, 'iframe']),
);

const CHALLENGE_TEXT = [
  /\bcaptcha\b/i,
  /\brecaptcha\b/i,
  /\bhcaptcha\b/i,
  /\bturnstile\b/i,
  /verify (that )?you(?:'| a)?re human/i,
  /verifying you are human/i,
  /\bi'?m not a robot\b/i,
  /\bhuman verification\b/i,
  /\bsecurity (check|verification)\b/i,
  /\bchecking your browser\b/i,
  /\bplease (complete|solve) the (security )?(check|verification|challenge)\b/i,
  /\bselect all (the )?(boxes|images|squares)\b/i,
  /\bunusual (traffic|activity)\b/i,
  /\baccess denied\b/i,
  /\bray id\b/i,
  /\bverify selection\b/i,
];

const LOGIN_TEXT = [
  /\bsign in to continue\b/i,
  /\bplease (log|sign)\s?in\b/i,
  /\byour session has (expired|timed out)\b/i,
  /\bsession (expired|timed out)\b/i,
  /\byou (are|have been) logged out\b/i,
  /\bunauthori[sz]ed\b/i,
];

const MFA_TEXT = [
  /\bone[- ]time (password|pin|code)\b/i,
  /\bOTP\b/,
  /\bverification code\b/i,
  /\btwo[- ]factor\b/i,
  /\bauthenticator app\b/i,
];

const SITE_ERROR_TEXT = [
  /\bservice (temporarily )?unavailable\b/i,
  /\bunder maintenance\b/i,
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\btoo many requests\b/i,
];

const CHALLENGE_IFRAME_SRC = [
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /challenges\.cloudflare\.com/i,
  /captcha/i,
];

export type ChallengeKind = 'CAPTCHA' | 'LOGIN' | 'MFA' | 'SITE_ERROR' | 'NONE';

export interface Detection {
  detected: boolean;
  kind: ChallengeKind;
  reason: string;
}

const NEGATIVE: Detection = { detected: false, kind: 'NONE', reason: '' };

function firstMatch(patterns: RegExp[], text: string): RegExp | null {
  for (const pattern of patterns) if (pattern.test(text)) return pattern;
  return null;
}

/** Captures a page into the flat shape the detectors work on. */
export async function capture(page: Page, httpStatus: number | null = null): Promise<PageSnapshot> {
  const data = await page.evaluate((probes: string[]) => {
    const isVisible = (el: Element): boolean => {
      const node = el as HTMLElement;
      if (node.tagName === 'IFRAME') return true;
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
        // ignore selectors this browser cannot parse
      }
    }

    return {
      url: location.href,
      title: document.title,
      visibleText: (document.body?.innerText ?? '').slice(0, 40_000),
      visibleMatches,
      iframes: Array.from(document.querySelectorAll('iframe')).map((frame) => ({
        src: frame.getAttribute('src') ?? '',
        title: frame.getAttribute('title') ?? '',
      })),
    };
  }, PROBE_SELECTORS);

  return { ...data, httpStatus };
}

const CHALLENGE_SET = new Set(CHALLENGE_SELECTORS);
const LOGIN_SET = new Set(LOGIN_SELECTORS);
const AUTH_SET = new Set(AUTHENTICATED_SELECTORS);

export function detectChallenge(snapshot: PageSnapshot): Detection {
  for (const frame of snapshot.iframes) {
    const haystack = `${frame.src} ${frame.title}`;
    const hit = firstMatch(CHALLENGE_IFRAME_SRC, haystack);
    if (hit) {
      return { detected: true, kind: 'CAPTCHA', reason: `verification iframe matched ${hit}` };
    }
  }

  const selector = snapshot.visibleMatches.find((sel) => CHALLENGE_SET.has(sel));
  if (selector) {
    return { detected: true, kind: 'CAPTCHA', reason: `visible challenge element "${selector}"` };
  }

  const textHit = firstMatch(CHALLENGE_TEXT, snapshot.visibleText) ?? firstMatch(CHALLENGE_TEXT, snapshot.title);
  if (textHit) return { detected: true, kind: 'CAPTCHA', reason: `page text matched ${textHit}` };

  const mfaHit = firstMatch(MFA_TEXT, snapshot.visibleText);
  if (mfaHit) return { detected: true, kind: 'MFA', reason: `page text matched ${mfaHit}` };

  return NEGATIVE;
}

export function detectLogin(snapshot: PageSnapshot): Detection {
  const hasAuthMarker =
    snapshot.visibleMatches.some((sel) => AUTH_SET.has(sel)) ||
    /\blog\s?out\b|\bsign\s?out\b/i.test(snapshot.visibleText);
  if (hasAuthMarker) return NEGATIVE;

  const selector = snapshot.visibleMatches.find((sel) => LOGIN_SET.has(sel));
  if (selector) {
    return { detected: true, kind: 'LOGIN', reason: `visible login control "${selector}"` };
  }

  const textHit = firstMatch(LOGIN_TEXT, snapshot.visibleText);
  if (textHit) return { detected: true, kind: 'LOGIN', reason: `page text matched ${textHit}` };

  if (/[?&]returnurl=/i.test(snapshot.url) || /\/(login|signin)\b/i.test(snapshot.url)) {
    return { detected: true, kind: 'LOGIN', reason: `url looks like a login route` };
  }

  return NEGATIVE;
}

export function detectSiteError(snapshot: PageSnapshot): Detection {
  if (typeof snapshot.httpStatus === 'number' && snapshot.httpStatus >= 500) {
    return { detected: true, kind: 'SITE_ERROR', reason: `HTTP ${snapshot.httpStatus}` };
  }
  if (snapshot.httpStatus === 429) {
    return { detected: true, kind: 'SITE_ERROR', reason: 'HTTP 429 (rate limited)' };
  }
  const hit = firstMatch(SITE_ERROR_TEXT, snapshot.visibleText);
  if (hit) return { detected: true, kind: 'SITE_ERROR', reason: `page text matched ${hit}` };
  return NEGATIVE;
}

export function detectAuthenticated(snapshot: PageSnapshot): Detection {
  if (detectLogin(snapshot).detected) return NEGATIVE;
  const marker = snapshot.visibleMatches.find((sel) => AUTH_SET.has(sel));
  if (marker) return { detected: true, kind: 'NONE', reason: `authenticated marker "${marker}"` };
  if (/\blog\s?out\b|\bsign\s?out\b|\bmy account\b/i.test(snapshot.visibleText)) {
    return { detected: true, kind: 'NONE', reason: 'authenticated text marker' };
  }
  return NEGATIVE;
}

/** Any condition that should stop automation and call a human. */
export function detectBlocking(snapshot: PageSnapshot): Detection {
  const challenge = detectChallenge(snapshot);
  if (challenge.detected) return challenge;
  const siteError = detectSiteError(snapshot);
  if (siteError.detected) return siteError;
  const login = detectLogin(snapshot);
  if (login.detected) return login;
  return NEGATIVE;
}

/** Query strings can carry session identifiers, so they never reach a log. */
export function redactQuery(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : `${url.slice(0, cut)}?[redacted]`;
}
