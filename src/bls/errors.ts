/** Stable error codes surfaced to the UI, the event log and Telegram. */
export const BlsErrorCode = {
  WEBSITE_STRUCTURE_CHANGED: 'WEBSITE_STRUCTURE_CHANGED',
  LAGOS_SELECTION_ERROR: 'LAGOS_SELECTION_ERROR',
  VISA_CATEGORY_NOT_FOUND: 'VISA_CATEGORY_NOT_FOUND',
  APPLICANT_SELECTION_ERROR: 'APPLICANT_SELECTION_ERROR',
  SITE_UNAVAILABLE: 'SITE_UNAVAILABLE',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type BlsErrorCode = (typeof BlsErrorCode)[keyof typeof BlsErrorCode];

export interface PageEvidence {
  url?: string | null;
  title?: string | null;
  /** Trimmed, truncated visible page text. Never contains form input values. */
  visibleText?: string | null;
  screenshotPath?: string | null;
}

export class BlsError extends Error {
  readonly code: BlsErrorCode;
  readonly evidence: PageEvidence;

  constructor(code: BlsErrorCode, message: string, evidence: PageEvidence = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.evidence = evidence;
  }
}

/**
 * Raised whenever the appointment workflow cannot be interpreted safely.
 * Callers must never downgrade this to "no appointments available".
 */
export class WebsiteStructureChangedError extends BlsError {
  constructor(message: string, evidence: PageEvidence = {}) {
    super(BlsErrorCode.WEBSITE_STRUCTURE_CHANGED, message, evidence);
  }
}

/** Lagos could not be selected. We stop rather than fall through to Abuja. */
export class LagosSelectionError extends BlsError {
  constructor(message: string, evidence: PageEvidence = {}) {
    super(BlsErrorCode.LAGOS_SELECTION_ERROR, message, evidence);
  }
}

/** The configured visa category is not offered. We never pick a different one. */
export class VisaCategoryNotFoundError extends BlsError {
  readonly availableCategories: string[];

  constructor(message: string, availableCategories: string[], evidence: PageEvidence = {}) {
    super(BlsErrorCode.VISA_CATEGORY_NOT_FOUND, message, evidence);
    this.availableCategories = availableCategories;
  }
}

/**
 * The portal bounced us to its login route.
 *
 * BLS answers unauthenticated appointment requests with a 302 to a plain-http
 * login URL whose port does not respond, so the navigation hangs instead of
 * landing on a login page. Seeing that redirect is therefore a positive
 * "you are logged out" signal, not a site outage.
 */
export class LoginRequiredError extends BlsError {
  constructor(message: string, evidence: PageEvidence = {}) {
    super(BlsErrorCode.LOGIN_REQUIRED, message, evidence);
  }
}

/** The applicant type or member count could not be set as configured. */
export class ApplicantSelectionError extends BlsError {
  constructor(message: string, evidence: PageEvidence = {}) {
    super(BlsErrorCode.APPLICANT_SELECTION_ERROR, message, evidence);
  }
}

export class SiteUnavailableError extends BlsError {
  constructor(message: string, evidence: PageEvidence = {}) {
    super(BlsErrorCode.SITE_UNAVAILABLE, message, evidence);
  }
}

export function toBlsError(err: unknown): BlsError {
  if (err instanceof BlsError) return err;
  const error = err instanceof Error ? err : new Error(String(err));
  const transient = /timeout|net::|ERR_|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up/i;
  if (transient.test(error.message)) {
    return new SiteUnavailableError(error.message);
  }
  return new BlsError(BlsErrorCode.UNKNOWN, error.message);
}
