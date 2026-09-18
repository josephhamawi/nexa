/**
 * The full status vocabulary. Every check must end in exactly one of these.
 *
 * Crucially, NOT_AVAILABLE is reserved for the case where the BLS page
 * explicitly said there is nothing to book. Anything the adapter could not
 * interpret maps to an error status instead, see docs in BlsAvailabilityParser.
 */
export const AvailabilityStatus = {
  MONITORING: 'MONITORING',
  AVAILABLE: 'AVAILABLE',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  CAPTCHA_REQUIRED: 'CAPTCHA_REQUIRED',
  HUMAN_VERIFICATION_REQUIRED: 'HUMAN_VERIFICATION_REQUIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SITE_UNAVAILABLE: 'SITE_UNAVAILABLE',
  ERROR: 'ERROR',
  PAUSED: 'PAUSED',
  STOPPED: 'STOPPED',
} as const;

export type AvailabilityStatus = (typeof AvailabilityStatus)[keyof typeof AvailabilityStatus];

export const ALL_STATUSES: AvailabilityStatus[] = Object.values(AvailabilityStatus);

/** Statuses that require the user to do something in the browser themselves. */
const MANUAL_ACTION_STATUSES = new Set<AvailabilityStatus>([
  AvailabilityStatus.LOGIN_REQUIRED,
  AvailabilityStatus.CAPTCHA_REQUIRED,
  AvailabilityStatus.HUMAN_VERIFICATION_REQUIRED,
  AvailabilityStatus.SESSION_EXPIRED,
]);

/** Statuses that mean the check failed rather than returned an answer. */
const ERROR_STATUSES = new Set<AvailabilityStatus>([
  AvailabilityStatus.SITE_UNAVAILABLE,
  AvailabilityStatus.ERROR,
]);

/** Statuses after which the monitoring worker must not schedule another poll. */
const HALTING_STATUSES = new Set<AvailabilityStatus>([
  AvailabilityStatus.AVAILABLE,
  AvailabilityStatus.LOGIN_REQUIRED,
  AvailabilityStatus.CAPTCHA_REQUIRED,
  AvailabilityStatus.HUMAN_VERIFICATION_REQUIRED,
  AvailabilityStatus.SESSION_EXPIRED,
  AvailabilityStatus.PAUSED,
  AvailabilityStatus.STOPPED,
]);

export function requiresManualAction(status: AvailabilityStatus): boolean {
  return MANUAL_ACTION_STATUSES.has(status);
}

export function isErrorStatus(status: AvailabilityStatus): boolean {
  return ERROR_STATUSES.has(status);
}

/** True when the worker should stop polling and wait for the user. */
export function haltsMonitoring(status: AvailabilityStatus): boolean {
  return HALTING_STATUSES.has(status);
}

/**
 * The only transition that fires the APPOINTMENT_FOUND alert.
 * A previous status of AVAILABLE does not re-trigger, so a slot that stays
 * open does not spam notifications.
 */
export function isAppointmentFoundTransition(
  previous: AvailabilityStatus | null,
  next: AvailabilityStatus,
): boolean {
  if (next !== AvailabilityStatus.AVAILABLE) return false;
  return previous !== AvailabilityStatus.AVAILABLE;
}

/** Human-readable one-liner for the dashboard and the event log. */
export function describeStatus(status: AvailabilityStatus): string {
  switch (status) {
    case AvailabilityStatus.MONITORING:
      return 'Monitoring';
    case AvailabilityStatus.AVAILABLE:
      return 'Appointment available';
    case AvailabilityStatus.NOT_AVAILABLE:
      return 'No appointments available';
    case AvailabilityStatus.LOGIN_REQUIRED:
      return 'Login required';
    case AvailabilityStatus.CAPTCHA_REQUIRED:
      return 'CAPTCHA required';
    case AvailabilityStatus.HUMAN_VERIFICATION_REQUIRED:
      return 'Human verification required';
    case AvailabilityStatus.SESSION_EXPIRED:
      return 'Session expired';
    case AvailabilityStatus.SITE_UNAVAILABLE:
      return 'BLS website unavailable';
    case AvailabilityStatus.ERROR:
      return 'Check failed';
    case AvailabilityStatus.PAUSED:
      return 'Paused';
    case AvailabilityStatus.STOPPED:
      return 'Stopped';
    default:
      return status;
  }
}
