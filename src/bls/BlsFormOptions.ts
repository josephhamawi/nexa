/**
 * Choices offered in the dashboard's visa dropdowns.
 *
 * The authoritative list lives on the BLS booking form, which is behind login,
 * so two sources are combined:
 *
 *   1. SEEDED_* below, taken from the visa pages published on
 *      nigeria.blsspainvisa.com. Enough to pick from before you sign in.
 *   2. Whatever the live form actually offers, read by
 *      BlsSpainAdapter.discoverFormOptions() once you are authenticated and
 *      cached in data/state/bls-options.json.
 *
 * Discovered values always win. Any value you have already saved is kept in the
 * list even if neither source mentions it, so a configuration is never silently
 * dropped, and every dropdown keeps a "Custom" escape hatch for wording we have
 * not seen yet.
 */

export interface BlsFormOptions {
  visaTypes: string[];
  /** Sub-categories, keyed by the visa type they belong to. */
  subCategories: Record<string, string[]>;
  applicantTypes: string[];
  /** ISO-8601 instant of the last successful discovery, null if never. */
  discoveredAt: string | null;
  /** True when the lists came from the live BLS form rather than the seed. */
  fromLiveForm: boolean;
  /** Centre list as seen on the form. Reported for transparency only. */
  locations: string[];
}

export const SHORT_STAY = 'Short Stay';
export const NATIONAL = 'National';

export const SEEDED_VISA_TYPES: string[] = [SHORT_STAY, NATIONAL];

/** Short-stay (Schengen) categories published on the Nigeria site. */
export const SEEDED_SHORT_STAY_CATEGORIES: string[] = [
  'Tourist',
  'Business',
  'Family or Friends Visit',
  'Medical',
  'Conference',
  'Transit',
  'Study (under 90 days)',
];

/** National (long-stay) categories published on the Nigeria site. */
export const SEEDED_NATIONAL_CATEGORIES: string[] = [
  'Student',
  'Employee',
  'Family Reunification',
  'Non-Working Residence',
  'Entrepreneur',
  'Investor',
  'Researcher',
  'Highly Qualified Worker',
  'Internship',
  'Long Term Residence',
  'Residence EU',
  'Spouse of EU Citizen',
  'Minor of Non-EU Resident',
  'Ascendent of Non-EU Resident',
];

export const SEEDED_APPLICANT_TYPES: string[] = ['Individual', 'Family', 'Group'];

export function seededOptions(): BlsFormOptions {
  return {
    visaTypes: [...SEEDED_VISA_TYPES],
    subCategories: {
      [SHORT_STAY]: [...SEEDED_SHORT_STAY_CATEGORIES],
      [NATIONAL]: [...SEEDED_NATIONAL_CATEGORIES],
    },
    applicantTypes: [...SEEDED_APPLICANT_TYPES],
    discoveredAt: null,
    fromLiveForm: false,
    locations: ['Lagos'],
  };
}

/**
 * Folds discovered values and the user's saved values into the seeded lists.
 * Order: live values first, then seeded ones, then anything the user saved.
 */
export function mergeOptions(
  base: BlsFormOptions,
  saved: { visaType?: string; visaSubCategory?: string; applicantType?: string } = {},
): BlsFormOptions {
  const seeded = seededOptions();

  const visaTypes = unique([...base.visaTypes, ...seeded.visaTypes, saved.visaType]);

  const subCategories: Record<string, string[]> = {};
  for (const type of visaTypes) {
    subCategories[type] = unique([
      ...(base.subCategories[type] ?? []),
      ...(seeded.subCategories[type] ?? []),
      // A saved category belongs to the type it was saved against.
      saved.visaType === type ? saved.visaSubCategory : undefined,
    ]);
  }

  return {
    visaTypes,
    subCategories,
    applicantTypes: unique([...base.applicantTypes, ...seeded.applicantTypes, saved.applicantType]),
    discoveredAt: base.discoveredAt,
    fromLiveForm: base.fromLiveForm,
    locations: unique([...base.locations, 'Lagos']),
  };
}

function unique(values: (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
