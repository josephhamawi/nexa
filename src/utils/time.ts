/** Date/time normalisation helpers. All output is locale-independent. */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Normalises a date to YYYY-MM-DD.
 * Accepts ISO (2026-10-14), slashed d/m/Y and Y/m/d, and textual forms
 * ("14 October 2026", "October 14, 2026", "14-Oct-2026").
 * Returns null when the input cannot be interpreted with confidence, callers
 * must treat null as "could not parse", never as "no appointment".
 */
export function normalizeDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  // 2026-10-14 / 2026/10/14
  const iso = raw.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 14 October 2026 / 14-Oct-2026 / 14 Oct 26
  const dmy = raw.match(/\b(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{2,4})\b/);
  if (dmy) {
    const month = MONTHS[dmy[2]!.toLowerCase()];
    if (month) return buildDate(expandYear(Number(dmy[3])), month, Number(dmy[1]));
  }

  // October 14, 2026 / Oct 14 2026
  const mdy = raw.match(/\b([A-Za-z]{3,9})[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?[\s\-/.,]+(\d{2,4})\b/);
  if (mdy) {
    const month = MONTHS[mdy[1]!.toLowerCase()];
    if (month) return buildDate(expandYear(Number(mdy[3])), month, Number(mdy[2]));
  }

  // 14/10/2026, day-first. BLS Nigeria uses en-GB ordering throughout.
  const slashed = raw.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/);
  if (slashed) return buildDate(Number(slashed[3]), Number(slashed[2]), Number(slashed[1]));

  return null;
}

function expandYear(year: number): number {
  if (year >= 1000) return year;
  return year < 70 ? 2000 + year : 1900 + year;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return null; // e.g. 31 February
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Normalises a time to 24h HH:mm.
 * Accepts "09:30", "9:30 AM", "09.30", "0930 hrs", "09:30:00", "9 AM".
 * Returns null when it cannot be interpreted.
 */
export function normalizeTime(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  const meridiem = raw.match(/\b(\d{1,2})(?:[:.](\d{2}))?(?::\d{2})?\s*([ap])\.?m\.?\b/i);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = meridiem[2] ? Number(meridiem[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const isPm = meridiem[3]!.toLowerCase() === 'p';
    if (isPm && hour !== 12) hour += 12;
    if (!isPm && hour === 12) hour = 0;
    return `${pad(hour)}:${pad(minute)}`;
  }

  const hm = raw.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?::[0-5]\d)?\b/);
  if (hm) return `${pad(Number(hm[1]))}:${hm[2]}`;

  // Compact military form: 0930, 1415 (hrs optional)
  const compact = raw.match(/\b([01]\d|2[0-3])([0-5]\d)\s*(?:h|hrs|hours)?\b/i);
  if (compact) return `${compact[1]}:${compact[2]}`;

  return null;
}

/** "2026-10-14" -> "14 October 2026" for human-facing messages. */
export function formatDateLong(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDate;
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${Number(m[3])} ${names[Number(m[2]) - 1]} ${m[1]}`;
}

/** Local wall-clock HH:mm:ss, used in notifications and the event log. */
export function formatClock(date: Date = new Date()): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Filesystem-safe timestamp: YYYY-MM-DD_HH-mm-ss (local time). */
export function fileTimestamp(date: Date = new Date()): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${pad(seconds)}s`;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
