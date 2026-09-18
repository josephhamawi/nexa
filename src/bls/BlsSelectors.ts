/**
 * Every selector, URL and text pattern used against BLS lives here.
 *
 * Observed on the live site (September 2026):
 *   - Marketing site:  https://nigeria.blsspainvisa.com/          (static PHP)
 *   - Booking portal:  https://nigeria.blsspainglobal.com/Global/ (ASP.NET Core MVC + Kendo UI)
 *   - Unauthenticated portal routes 302 to /Global/Account/LogIn?ReturnUrl=...
 *   - The login form uses decoy inputs (UserId1..10 / Password1..10), a
 *     scrambled virtual keyboard and a first-party image CAPTCHA served from
 *     /Global/CaptchaPublic/GenerateCaptcha.
 *
 * The portal's post-login pages are behind authentication, so their markup is
 * intentionally NOT assumed here. Anything past login is addressed through
 * role/label/text strategies with fallbacks; when every strategy misses, the
 * adapter raises WebsiteStructureChangedError instead of guessing.
 */

export type SelectorStrategy =
  | { kind: 'role'; role: RoleName; name?: string | RegExp; exact?: boolean }
  | { kind: 'label'; text: string | RegExp }
  | { kind: 'placeholder'; text: string | RegExp }
  | { kind: 'text'; text: string | RegExp }
  | { kind: 'css'; selector: string };

export type RoleName =
  | 'button'
  | 'link'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'textbox'
  | 'heading'
  | 'table'
  | 'grid'
  | 'gridcell'
  | 'cell'
  | 'radio'
  | 'alert';

export const PORTAL_ORIGIN = 'https://nigeria.blsspainglobal.com';

export const BLS_URLS = {
  publicSite: 'https://nigeria.blsspainvisa.com/',
  portalOrigin: PORTAL_ORIGIN,
  /**
   * Entry point for every check: the appointment route, never the login route.
   *
   * Requesting /Global/account/login while signed in tears the session down on
   * this portal, which logged the user straight back out after every sign-in.
   * The login URL is therefore only ever opened by an explicit "Sign in to BLS"
   * action, never by a check.
   *
   * When the session IS dead, this route answers with a 302 to a plain-http URL
   * whose port does not respond, so the navigation would hang. The adapter
   * watches for that redirect and fails fast with LOGIN_REQUIRED instead.
   */
  entry: `${PORTAL_ORIGIN}/Global/blsappointment/MyAppointments`,
  login: `${PORTAL_ORIGIN}/Global/account/login`,
  /**
   * "Book New Appointment". Observed to be the only door into the booking
   * funnel, and it is human-verification gated: the page ships nothing but a
   * "Verify Selection" button, and the visa dropdowns are rendered only after
   * the image challenge behind it is solved by a person.
   */
  bookNewAppointment: `${PORTAL_ORIGIN}/Global/bls/visatypeverification`,
  myAppointments: `${PORTAL_ORIGIN}/Global/blsappointment/MyAppointments`,
  visaTypeVerification: `${PORTAL_ORIGIN}/Global/bls/visatypeverification`,
  /**
   * Candidate entry points for "book a new appointment", tried in order.
   * The portal renames these occasionally; link-text navigation from
   * MyAppointments is the primary route and these are the fallback.
   */
  appointmentEntryCandidates: [
    `${PORTAL_ORIGIN}/Global/bls/visatypeverification`,
    `${PORTAL_ORIGIN}/Global/blsappointment/MyAppointments`,
    `${PORTAL_ORIGIN}/Global/blsappointment/Appointment`,
    `${PORTAL_ORIGIN}/Global/blsappointment/NewAppointment`,
    `${PORTAL_ORIGIN}/Global/blsappointment/SlotSelection`,
  ],
} as const;

/** URL fragments that mean "you are on (or were bounced to) the login flow". */
export const LOGIN_URL_PATTERNS: RegExp[] = [
  /\/account\/login/i,
  /\/account\/logon/i,
  /returnurl=/i,
  /\/account\/sessionexpired/i,
];

export const APPOINTMENT_URL_PATTERNS: RegExp[] = [/\/blsappointment\//i, /appointment/i];

/** Markers that identify the login page itself. */
export const LOGIN_PAGE_MARKERS: SelectorStrategy[] = [
  { kind: 'css', selector: 'form[action*="loginsubmit" i]' },
  { kind: 'css', selector: 'input[name^="UserId"]' },
  { kind: 'css', selector: 'input[name^="Password"]' },
  { kind: 'css', selector: 'input[type="password"]' },
  { kind: 'role', role: 'button', name: /^\s*log\s?in\s*$/i },
];

export const LOGIN_TEXT_PATTERNS: RegExp[] = [
  /\bsign\s?in\b/i,
  /\blog\s?in\b/i,
  /\byour session has (expired|timed out)\b/i,
  /\bsession (expired|timeout|timed out)\b/i,
  /\bplease (log|sign)\s?in (again )?to continue\b/i,
  /\byou (are|have been) logged out\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bforgot (user\s?id|password)\b/i,
];

/**
 * Markers that prove we are on an authenticated page. Used as the positive
 * half of login detection: a page that has none of these and matches the
 * login markers is treated as LOGIN_REQUIRED.
 */
export const AUTHENTICATED_MARKERS: SelectorStrategy[] = [
  { kind: 'role', role: 'link', name: /log\s?out|sign\s?out/i },
  { kind: 'role', role: 'button', name: /log\s?out|sign\s?out/i },
  { kind: 'css', selector: 'a[href*="logout" i]' },
  { kind: 'css', selector: '[onclick*="Logout" i]' },
  { kind: 'text', text: /my appointments/i },
];

/** Session-expiry wording, distinct from a plain "please log in". */
export const SESSION_EXPIRED_PATTERNS: RegExp[] = [
  /\bsession (has )?(expired|timed out)\b/i,
  /\byour session is no longer valid\b/i,
  /\bplease login again\b/i,
  /\bidle (for )?too long\b/i,
];

/**
 * Human-verification detection.
 * These are detection-only patterns. Nothing in this project interacts with,
 * submits, or attempts to solve any of them.
 */
export const CAPTCHA_TEXT_PATTERNS: RegExp[] = [
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
  /\bselect all images\b/i,
  /\bplease verify to continue\b/i,
  /\bunusual (traffic|activity)\b/i,
  /\baccess denied\b/i,
  // BLS's own wording for its first-party image challenge.
  /\bverify selection\b/i,
  /\bverify registration\b/i,
  /\bplease select all boxes\b/i,
  /\bselect all (the )?(boxes|images|squares)\b/i,
  /\bray id\b/i,
];

export const CAPTCHA_SELECTORS: SelectorStrategy[] = [
  { kind: 'css', selector: 'iframe[src*="recaptcha" i]' },
  { kind: 'css', selector: 'iframe[src*="hcaptcha" i]' },
  { kind: 'css', selector: 'iframe[src*="turnstile" i]' },
  { kind: 'css', selector: 'iframe[src*="challenges.cloudflare.com" i]' },
  { kind: 'css', selector: 'iframe[src*="captcha" i]' },
  { kind: 'css', selector: 'iframe[title*="captcha" i]' },
  { kind: 'css', selector: 'iframe[title*="challenge" i]' },
  { kind: 'css', selector: 'iframe[src*="GenerateCaptcha" i]' },
  { kind: 'css', selector: '.g-recaptcha' },
  { kind: 'css', selector: '.h-captcha' },
  { kind: 'css', selector: '.cf-turnstile' },
  { kind: 'css', selector: '#cf-challenge-running' },
  { kind: 'css', selector: '#challenge-form' },
  { kind: 'css', selector: '[id*="captcha" i]:not(script)' },
  { kind: 'css', selector: '[class*="captcha" i]' },
  { kind: 'css', selector: '[data-sitekey]' },
  // BLS-specific: the verify button that opens its image challenge. The
  // matching CaptchaData input is hidden, so the button is what we look for.
  { kind: 'css', selector: '#btnVerify' },
  { kind: 'css', selector: '[onclick*="VerifyCaptcha" i]' },
  { kind: 'css', selector: '[onclick*="VerifyRegister" i]' },
  { kind: 'css', selector: '[onclick*="GenerateCaptcha" i]' },
];

/** Iframe src fragments treated as a human-verification frame. */
export const CAPTCHA_IFRAME_SRC_PATTERNS: RegExp[] = [
  /recaptcha/i,
  /hcaptcha/i,
  /turnstile/i,
  /challenges\.cloudflare\.com/i,
  /captcha/i,
  /GenerateCaptcha/i,
];

/** MFA / OTP, detection only, never automated. */
export const MFA_TEXT_PATTERNS: RegExp[] = [
  /\bone[- ]time (password|pin|code)\b/i,
  /\bOTP\b/,
  /\bverification code\b/i,
  /\btwo[- ]factor\b/i,
  /\bauthenticator app\b/i,
  /\bwe sent (you )?a code\b/i,
];

/** Site-down / maintenance wording. Distinct from "no appointments". */
export const SITE_ERROR_PATTERNS: RegExp[] = [
  /\bservice (temporarily )?unavailable\b/i,
  /\bunder maintenance\b/i,
  /\bsite is (currently )?down\b/i,
  /\bwe(?:'| a)re sorry,? (an )?(unexpected )?error\b/i,
  /\binternal server error\b/i,
  /\b(50[0-4]|429)\s*[-–—]?\s*(error|bad gateway|gateway timeout|too many requests)\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\btoo many requests\b/i,
  /\btry again later\b/i,
  /\bruntime error\b/i,
];

/**
 * Explicit "nothing to book" wording.
 * ONLY these phrases are allowed to produce NOT_AVAILABLE. If none matches and
 * no slots were parsed, the adapter raises WebsiteStructureChangedError.
 */
export const NO_APPOINTMENT_PATTERNS: RegExp[] = [
  /\bno (appointment|appointments|slot|slots)\b[^.]{0,80}\b(available|free|found|open)\b/i,
  /\bno\s+(available|free)\s+(appointment|appointments|slot|slots|date|dates)\b/i,
  /\b(appointment|slot)s?\s+(are|is)\s+not\s+available\b/i,
  /\bthere (are|is) (currently )?no (appointment|slot)s?\b/i,
  /\bcurrently,? (there are )?no (appointment|slot)s?\b/i,
  /\bappointment (slots? )?(is|are) full\b/i,
  /\bno dates? (are )?available\b/i,
  /\bfully booked\b/i,
  /\bslots? (are )?(not available|unavailable|exhausted)\b/i,
  /\bplease (try|check) again (later|after some time)\b.{0,60}\bappointment\b/i,
  /\bappointment\b.{0,60}\bplease (try|check) again (later|after some time)\b/i,
];

/** Wording that positively indicates slots exist. */
export const HAS_APPOINTMENT_PATTERNS: RegExp[] = [
  /\bslots? available\b/i,
  /\bappointments? available\b/i,
  /\bavailable (appointment|slot)s?\b/i,
  /\bselect (a |an )?(appointment )?(date|time|slot)\b/i,
  /\bchoose (a |an )?(appointment )?(date|time|slot)\b/i,
];

/** Entry points into the booking flow, tried in order. */
export const BOOK_APPOINTMENT_LINKS: SelectorStrategy[] = [
  { kind: 'role', role: 'link', name: /book (a |an )?(new )?appointment/i },
  { kind: 'role', role: 'button', name: /book (a |an )?(new )?appointment/i },
  { kind: 'role', role: 'link', name: /new appointment/i },
  { kind: 'role', role: 'button', name: /new appointment/i },
  { kind: 'role', role: 'link', name: /schedule appointment/i },
  { kind: 'role', role: 'link', name: /appointment booking/i },
  { kind: 'css', selector: 'a[href*="blsappointment" i]' },
  { kind: 'text', text: /book appointment/i },
];

/**
 * Location / centre control. Lagos is the ONLY acceptable value; the adapter
 * verifies the selection afterwards and raises LagosSelectionError otherwise.
 */
export const LOCATION_CONTROLS: SelectorStrategy[] = [
  { kind: 'label', text: /location|centre|center|city|office|jurisdiction/i },
  { kind: 'role', role: 'combobox', name: /location|centre|center|city|office/i },
  { kind: 'css', selector: 'select[name*="location" i]' },
  { kind: 'css', selector: 'select[name*="centre" i]' },
  { kind: 'css', selector: 'select[name*="center" i]' },
  { kind: 'css', selector: 'select[name*="city" i]' },
  { kind: 'css', selector: 'select[id*="location" i]' },
  { kind: 'css', selector: '[data-role="dropdownlist"][id*="location" i]' },
  { kind: 'css', selector: '[data-role="dropdownlist"][id*="centre" i]' },
];

export const LAGOS_PATTERN = /\blagos\b/i;

/** Never selected. Present only so the adapter can assert it did NOT pick it. */
export const FORBIDDEN_CENTRE_PATTERN = /\babuja\b/i;

export const VISA_TYPE_CONTROLS: SelectorStrategy[] = [
  { kind: 'label', text: /visa (type|category)|category|appointment (type|for)|purpose/i },
  { kind: 'role', role: 'combobox', name: /visa (type|category)|category|appointment type|purpose/i },
  { kind: 'css', selector: 'select[name*="visatype" i]' },
  { kind: 'css', selector: 'select[name*="visacategory" i]' },
  { kind: 'css', selector: 'select[name*="category" i]' },
  { kind: 'css', selector: 'select[id*="visatype" i]' },
  { kind: 'css', selector: 'select[id*="category" i]' },
  { kind: 'css', selector: '[data-role="dropdownlist"][id*="visa" i]' },
  { kind: 'css', selector: '[data-role="dropdownlist"][id*="category" i]' },
];

/** Buttons that advance the wizard to the slot list. Never a final confirm. */
/** Second-level category control, when the portal asks twice. */
export const VISA_SUBCATEGORY_CONTROLS: SelectorStrategy[] = [
  { kind: 'label', text: /sub[- ]?category|visa sub|category type|sub type/i },
  { kind: 'role', role: 'combobox', name: /sub[- ]?category|visa sub|category type/i },
  { kind: 'css', selector: 'select[name*="subcategory" i]' },
  { kind: 'css', selector: 'select[name*="sub_category" i]' },
  { kind: 'css', selector: 'select[id*="subcategory" i]' },
  { kind: 'css', selector: '[data-role="dropdownlist"][id*="subcategory" i]' },
];

/** Individual / Family / Group selector. */
export const APPLICANT_TYPE_CONTROLS: SelectorStrategy[] = [
  { kind: 'label', text: /appointment (for|type)|applicant type|individual or family|booking type/i },
  { kind: 'role', role: 'combobox', name: /appointment (for|type)|applicant type|booking type/i },
  { kind: 'css', selector: 'select[name*="appointmentfor" i]' },
  { kind: 'css', selector: 'select[name*="applicanttype" i]' },
  { kind: 'css', selector: 'select[name*="appointmenttype" i]' },
  { kind: 'css', selector: 'select[id*="appointmentfor" i]' },
  { kind: 'css', selector: '[data-role="dropdownlist"][id*="appointmentfor" i]' },
];

/** Number of applicants / family members. Can be a select or a number input. */
export const MEMBER_COUNT_CONTROLS: SelectorStrategy[] = [
  { kind: 'label', text: /number of (applicants|members|persons|people)|no\.? of applicants|family members/i },
  { kind: 'role', role: 'combobox', name: /number of (applicants|members|persons)/i },
  { kind: 'role', role: 'textbox', name: /number of (applicants|members|persons)/i },
  { kind: 'css', selector: 'select[name*="noofapplicant" i]' },
  { kind: 'css', selector: 'select[name*="membercount" i]' },
  { kind: 'css', selector: 'select[name*="noofmember" i]' },
  { kind: 'css', selector: 'input[name*="noofapplicant" i]' },
  { kind: 'css', selector: 'input[name*="membercount" i]' },
  { kind: 'css', selector: 'input[type="number"][id*="member" i]' },
  { kind: 'css', selector: 'input[type="number"][id*="applicant" i]' },
];

export const CONTINUE_CONTROLS: SelectorStrategy[] = [
  { kind: 'role', role: 'button', name: /^\s*(continue|next|proceed|submit|search|check availability)\s*$/i },
  { kind: 'css', selector: 'button[type="submit"]:not([disabled])' },
  { kind: 'css', selector: 'input[type="submit"]:not([disabled])' },
];

/**
 * Controls this application must NEVER click. Enforced by the adapter's
 * assertNoBookingControlClicked guard and by code review.
 */
export const FORBIDDEN_ACTION_PATTERNS: RegExp[] = [
  /\bconfirm (appointment|booking)\b/i,
  /\bbook now\b/i,
  /\bpay\b/i,
  /\bpayment\b/i,
  /\bcheckout\b/i,
  /\bfinali[sz]e\b/i,
  /\bconfirm and pay\b/i,
];

/** Containers likely to hold the rendered slot calendar / slot table. */
export const SLOT_CONTAINERS: SelectorStrategy[] = [
  { kind: 'css', selector: '[data-role="calendar"]' },
  { kind: 'css', selector: '.k-calendar' },
  { kind: 'css', selector: '.k-scheduler' },
  { kind: 'css', selector: '.flatpickr-calendar' },
  { kind: 'css', selector: '.ui-datepicker' },
  { kind: 'css', selector: '[class*="calendar" i]' },
  { kind: 'css', selector: '[class*="timeslot" i]' },
  { kind: 'css', selector: '[class*="slot" i]' },
  { kind: 'css', selector: 'table' },
  { kind: 'role', role: 'table' },
  { kind: 'role', role: 'grid' },
];

/** Cells/buttons inside a calendar that represent a bookable day. */
export const AVAILABLE_DAY_SELECTORS: string[] = [
  'td.available:not(.disabled)',
  'td.k-state-selected',
  '.k-calendar td:not(.k-disabled):not(.k-other-month) a',
  '.flatpickr-day:not(.flatpickr-disabled):not(.prevMonthDay):not(.nextMonthDay).available',
  '.flatpickr-day.available',
  '[class*="day" i][class*="available" i]',
  '[class*="slot" i][class*="available" i]',
  'td[data-available="true"]',
  'a[class*="available" i]',
  'button[class*="available" i]:not([disabled])',
  '.available-date',
  '.appointment-available',
];

/** Elements holding a time value for a selected day. */
export const TIME_SLOT_SELECTORS: string[] = [
  '[class*="timeslot" i]:not([class*="disabled" i])',
  '[class*="time-slot" i]:not([class*="disabled" i])',
  'input[type="radio"][name*="slot" i]:not([disabled]) + label',
  'label[for*="slot" i]',
  'option[value]:not([value=""])',
  'button[class*="time" i]:not([disabled])',
  'td[class*="time" i]',
];

export const DISABLED_MARKERS = [
  'disabled',
  'k-disabled',
  'k-state-disabled',
  'flatpickr-disabled',
  'unavailable',
  'not-available',
  'booked',
  'full',
  'blocked',
  'holiday',
  'weekend',
  'empty',
  'other-month',
  'prevMonthDay',
  'nextMonthDay',
];
