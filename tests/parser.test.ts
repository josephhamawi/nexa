import { describe, expect, it } from 'vitest';
import { parseAvailability, extractSlotsFromText } from '../src/bls/BlsAvailabilityParser';
import { AvailabilityStatus } from '../src/availability/AvailabilityState';
import { snapshotFromFixture, snapshotFromHtml } from './helpers/snapshot';

const URL = 'https://nigeria.blsspainglobal.com/Global/blsappointment/MyAppointments';

describe('parseAvailability', () => {
  it('reports NOT_AVAILABLE only on explicit wording', () => {
    const outcome = parseAvailability({
      snapshot: snapshotFromFixture('no-appointments.html', URL),
      candidates: [],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe(AvailabilityStatus.NOT_AVAILABLE);
    expect(outcome.slots).toEqual([]);
  });

  it('reports AVAILABLE with normalised slots', () => {
    const outcome = parseAvailability({
      snapshot: snapshotFromFixture('appointment-available.html', URL),
      candidates: [
        { date: '14/10/2026', time: '09:30', source: 'tr' },
        { date: '14/10/2026', time: '11:15', source: 'tr' },
        { date: '21/11/2026', time: '14:00', source: 'tr' },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe(AvailabilityStatus.AVAILABLE);
    expect(outcome.slots).toEqual([
      { date: '2026-10-14', time: '09:30', metadata: { source: 'tr' } },
      { date: '2026-10-14', time: '11:15', metadata: { source: 'tr' } },
      { date: '2026-11-21', time: '14:00', metadata: { source: 'tr' } },
    ]);
  });

  // The single most important rule in this project.
  it('NEVER converts an uninterpretable page into "no appointments"', () => {
    const outcome = parseAvailability({
      snapshot: snapshotFromFixture('unexpected-page.html', URL),
      candidates: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/could not be interpreted/i);
    expect(outcome.evidence.length).toBeGreaterThan(0);
  });

  it('fails rather than answering when slot rows cannot be read', () => {
    const outcome = parseAvailability({
      snapshot: snapshotFromFixture('appointment-available.html', URL),
      candidates: [{ date: 'sometime in October', time: 'morning' }],
    });
    expect(outcome.ok).toBe(false);
  });

  it('fails when a "no appointments" message coexists with slot-like rows', () => {
    const outcome = parseAvailability({
      snapshot: snapshotFromFixture('no-appointments.html', URL),
      candidates: [{ date: 'Thursday next week' }],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/also contains slot-like rows/i);
  });

  it('raises a structure change when the page claims slots exist but none can be read', () => {
    // The availability fixture says "Available slots for Lagos" but the DOM
    // harvest returned nothing. Reporting NOT_AVAILABLE here would be a lie.
    const outcome = parseAvailability({
      snapshot: snapshotFromFixture('appointment-available.html', URL),
      candidates: [],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/suggests appointments exist/i);
  });

  it('falls back to reading dates out of the page text when a line carries both', () => {
    const snapshot = snapshotFromHtml(
      '<html><body><p>Available slot: 14/10/2026 09:30</p></body></html>',
      URL,
    );
    const outcome = parseAvailability({ snapshot, candidates: [] });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe(AvailabilityStatus.AVAILABLE);
    expect(outcome.slots).toEqual([{ date: '2026-10-14', time: '09:30' }]);
  });
});

describe('extractSlotsFromText', () => {
  it('only reads dates from availability-related lines', () => {
    const slots = extractSlotsFromText(
      [
        'Your passport is valid until 12/03/2031.',
        'Available slot: 14/10/2026 09:30',
        'Copyright 2026 BLS International',
      ].join('\n'),
    );
    expect(slots).toEqual([{ date: '2026-10-14', time: '09:30' }]);
  });

  it('returns nothing when no line mentions availability', () => {
    expect(extractSlotsFromText('Reference number 20261014\nIssued 01/01/2026')).toEqual([]);
  });
});
