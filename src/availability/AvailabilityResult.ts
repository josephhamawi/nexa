import { AvailabilityStatus, requiresManualAction } from './AvailabilityState';
import { normalizeDate, normalizeTime } from '../utils/time';

export interface AppointmentSlot {
  /** Always YYYY-MM-DD. */
  date: string;
  /** Always HH:mm (24h), or null when the site only exposes a date. */
  time: string | null;
  /** Anything else the page showed for the slot (category, location label…). */
  metadata?: Record<string, string>;
}

export interface AvailabilityResult {
  provider: 'BLS';
  country: 'Spain';
  city: 'Lagos';
  centre: 'Lagos';
  visaType: string;
  status: AvailabilityStatus;
  available: boolean;
  appointments: AppointmentSlot[];
  /** ISO-8601 UTC instant of the check. */
  checkedAt: string;
  message: string;
  screenshotPath?: string | null;
  requiresManualAction: boolean;
  /** Set when the result came from an error path, for the event log. */
  errorCode?: string | null;
  /** URL the adapter was on when it produced this result, diagnostics only. */
  url?: string | null;
}

export interface BuildResultInput {
  visaType: string;
  status: AvailabilityStatus;
  message: string;
  appointments?: AppointmentSlot[];
  screenshotPath?: string | null;
  errorCode?: string | null;
  url?: string | null;
  checkedAt?: Date;
}

/**
 * Single construction point for results, so `available` can never disagree
 * with `status` and every result carries the Lagos-only identity.
 */
export function buildResult(input: BuildResultInput): AvailabilityResult {
  const appointments = input.status === AvailabilityStatus.AVAILABLE ? (input.appointments ?? []) : [];
  return {
    provider: 'BLS',
    country: 'Spain',
    city: 'Lagos',
    centre: 'Lagos',
    visaType: input.visaType,
    status: input.status,
    available: input.status === AvailabilityStatus.AVAILABLE && appointments.length > 0,
    appointments,
    checkedAt: (input.checkedAt ?? new Date()).toISOString(),
    message: input.message,
    screenshotPath: input.screenshotPath ?? null,
    requiresManualAction: requiresManualAction(input.status),
    errorCode: input.errorCode ?? null,
    url: input.url ?? null,
  };
}

/**
 * Turns raw scraped strings into normalised slots.
 * A row whose date cannot be parsed is dropped from the slot list but reported
 * through `unparsed`, so the caller can decide to raise a structure-change
 * error rather than pretend the row did not exist.
 */
export function normalizeSlots(
  raw: { date: string; time?: string | null; metadata?: Record<string, string> }[],
): { slots: AppointmentSlot[]; unparsed: { date: string; time?: string | null }[] } {
  const slots: AppointmentSlot[] = [];
  const unparsed: { date: string; time?: string | null }[] = [];

  for (const row of raw) {
    const date = normalizeDate(row.date);
    if (!date) {
      unparsed.push({ date: row.date, time: row.time ?? null });
      continue;
    }
    const time = row.time ? normalizeTime(row.time) : null;
    if (row.time && !time) {
      unparsed.push({ date: row.date, time: row.time });
      continue;
    }
    slots.push({ date, time, ...(row.metadata ? { metadata: row.metadata } : {}) });
  }

  return { slots: dedupeSlots(slots), unparsed };
}

export function dedupeSlots(slots: AppointmentSlot[]): AppointmentSlot[] {
  const seen = new Set<string>();
  const out: AppointmentSlot[] = [];
  for (const slot of slots) {
    const key = `${slot.date}T${slot.time ?? '--:--'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.time ?? '').localeCompare(b.time ?? '');
  });
}

export interface SlotFilter {
  preferredDateFrom?: string;
  preferredDateTo?: string;
  preferredTimeFrom?: string;
  preferredTimeTo?: string;
}

/**
 * Applies the configured date/time windows.
 * Empty bounds mean "no bound". A slot with no time survives a time filter:
 * the site simply did not tell us the time, and dropping it would risk hiding
 * a real appointment.
 */
export function filterSlots(slots: AppointmentSlot[], filter: SlotFilter): AppointmentSlot[] {
  const { preferredDateFrom, preferredDateTo, preferredTimeFrom, preferredTimeTo } = filter;
  return slots.filter((slot) => {
    if (preferredDateFrom && slot.date < preferredDateFrom) return false;
    if (preferredDateTo && slot.date > preferredDateTo) return false;
    if (slot.time) {
      if (preferredTimeFrom && slot.time < preferredTimeFrom) return false;
      if (preferredTimeTo && slot.time > preferredTimeTo) return false;
    }
    return true;
  });
}

export function describeSlots(slots: AppointmentSlot[]): string {
  if (slots.length === 0) return 'no slots';
  return slots
    .slice(0, 8)
    .map((s) => (s.time ? `${s.date} ${s.time}` : s.date))
    .join(', ') + (slots.length > 8 ? ` (+${slots.length - 8} more)` : '');
}
