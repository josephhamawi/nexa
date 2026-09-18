import {
  detectAppointmentWording,
  detectNoAppointments,
  evidenceText,
  type PageSnapshot,
} from './BlsPageDetector';
import { AvailabilityStatus } from '../availability/AvailabilityState';
import { normalizeSlots, type AppointmentSlot } from '../availability/AvailabilityResult';
import { normalizeDate, normalizeTime } from '../utils/time';

/** A candidate slot harvested from the DOM, before normalisation. */
export interface RawSlotCandidate {
  date?: string | null;
  time?: string | null;
  /** Full text of the element, used for metadata and debugging. */
  label?: string | null;
  /** Which selector produced it, helps when selectors need updating. */
  source?: string;
}

export interface ParseInput {
  snapshot: PageSnapshot;
  candidates: RawSlotCandidate[];
}

export type ParseStatus =
  | typeof AvailabilityStatus.AVAILABLE
  | typeof AvailabilityStatus.NOT_AVAILABLE;

export interface ParseSuccess {
  ok: true;
  status: ParseStatus;
  slots: AppointmentSlot[];
  message: string;
  reason: string;
}

export interface ParseFailure {
  ok: false;
  /** Always a structure-change condition: the page could not be interpreted. */
  message: string;
  reason: string;
  evidence: string;
}

export type ParseOutcome = ParseSuccess | ParseFailure;

/**
 * Decides what an appointment page is actually saying.
 *
 * Order matters:
 *   1. Parsable slots  -> AVAILABLE
 *   2. Explicit "no appointments" wording -> NOT_AVAILABLE
 *   3. Anything else -> failure (structure change). Never NOT_AVAILABLE.
 */
export function parseAvailability(input: ParseInput): ParseOutcome {
  const { snapshot, candidates } = input;

  const { slots, unparsed } = normalizeSlots(
    candidates
      .filter((c) => Boolean(c.date))
      .map((c) => ({
        date: String(c.date),
        time: c.time ?? null,
        metadata: buildMetadata(c),
      })),
  );

  if (slots.length > 0) {
    return {
      ok: true,
      status: AvailabilityStatus.AVAILABLE,
      slots,
      message: `${slots.length} appointment slot${slots.length === 1 ? '' : 's'} visible for Lagos`,
      reason: `parsed ${slots.length} slot(s) from ${candidates.length} candidate element(s)`,
    };
  }

  const noAppointments = detectNoAppointments(snapshot);
  if (noAppointments.detected) {
    // Candidates that looked like slots but could not be normalised mean the
    // page is telling us two different things. Refuse to answer.
    if (unparsed.length > 0) {
      return {
        ok: false,
        message:
          'Page shows a "no appointments" message but also contains slot-like rows that could not be read',
        reason: `unparsed rows: ${JSON.stringify(unparsed.slice(0, 5))}`,
        evidence: evidenceText(snapshot),
      };
    }
    return {
      ok: true,
      status: AvailabilityStatus.NOT_AVAILABLE,
      slots: [],
      message: 'No appointments available',
      reason: noAppointments.reason,
    };
  }

  const positiveWording = detectAppointmentWording(snapshot);
  if (positiveWording.detected) {
    const textSlots = extractSlotsFromText(snapshot.visibleText);
    if (textSlots.length > 0) {
      return {
        ok: true,
        status: AvailabilityStatus.AVAILABLE,
        slots: textSlots,
        message: `${textSlots.length} appointment slot${textSlots.length === 1 ? '' : 's'} visible for Lagos`,
        reason: `parsed ${textSlots.length} slot(s) from page text (${positiveWording.reason})`,
      };
    }
    return {
      ok: false,
      message: 'Page suggests appointments exist but no slot could be read',
      reason: positiveWording.reason,
      evidence: evidenceText(snapshot),
    };
  }

  return {
    ok: false,
    message: 'Appointment page could not be interpreted safely',
    reason:
      unparsed.length > 0
        ? `no explicit availability wording; ${unparsed.length} unreadable slot-like row(s)`
        : 'no slots parsed and no explicit "no appointments" message on the page',
    evidence: evidenceText(snapshot),
  };
}

function buildMetadata(candidate: RawSlotCandidate): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  if (candidate.label) metadata.label = candidate.label.replace(/\s+/g, ' ').trim().slice(0, 160);
  if (candidate.source) metadata.source = candidate.source;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Last-resort text extraction, used only when the page positively states that
 * appointments exist. Restricted to lines that mention availability wording so
 * unrelated dates (validity periods, footer copyright) are not picked up.
 */
export function extractSlotsFromText(text: string): AppointmentSlot[] {
  const interesting = /\b(available|slot|appointment|select|choose|book)\b/i;
  const dateLike =
    /\b(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|\d{1,2}[\s\-/.]+[A-Za-z]{3,9}[\s\-/.,]+\d{2,4}|[A-Za-z]{3,9}[\s\-/.]+\d{1,2}(?:st|nd|rd|th)?[\s\-/.,]+\d{2,4})\b/g;
  const timeLike = /\b(?:[01]?\d|2[0-3])[:.][0-5]\d(?:\s*[ap]\.?m\.?)?\b|\b\d{1,2}\s*[ap]\.?m\.?\b/gi;

  const rows: { date: string; time: string | null }[] = [];

  for (const line of text.split(/\r?\n/)) {
    if (!interesting.test(line)) continue;
    const dates = line.match(dateLike);
    if (!dates) continue;
    const times = line.match(timeLike) ?? [];
    for (const rawDate of dates) {
      const date = normalizeDate(rawDate);
      if (!date) continue;
      if (times.length === 0) {
        rows.push({ date, time: null });
        continue;
      }
      for (const rawTime of times) {
        rows.push({ date, time: normalizeTime(rawTime) });
      }
    }
  }

  return normalizeSlots(rows.map((r) => ({ date: r.date, time: r.time }))).slots;
}
