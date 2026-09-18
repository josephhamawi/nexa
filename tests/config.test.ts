import { describe, expect, it } from 'vitest';
import { AppConfigSchema, BlsConfigSchema } from '../src/config/schema';

const valid = {
  bls: {
    enabled: true,
    country: 'Spain',
    applicationCountry: 'Nigeria',
    city: 'Lagos',
    centre: 'Lagos',
    visaType: 'Tourist',
    visaSubCategory: '',
    applicantType: 'Individual',
    memberCount: 1,
    preferredDateFrom: '',
    preferredDateTo: '',
    preferredTimeFrom: '',
    preferredTimeTo: '',
    intervalMinSeconds: 180,
    intervalMaxSeconds: 360,
  },
  notifications: { telegram: true, desktop: true, sound: true },
};

describe('configuration validation', () => {
  it('accepts the shipped default config', () => {
    const parsed = AppConfigSchema.parse(valid);
    expect(parsed.bls.centre).toBe('Lagos');
    expect(parsed.bls.manualCheckCooldownSeconds).toBe(90);
  });

  it('rejects any centre other than Lagos', () => {
    expect(() =>
      AppConfigSchema.parse({ ...valid, bls: { ...valid.bls, centre: 'Abuja' } }),
    ).toThrow();
    expect(() => AppConfigSchema.parse({ ...valid, bls: { ...valid.bls, city: 'Abuja' } })).toThrow();
  });

  it('rejects a polling interval below the 180s politeness floor', () => {
    expect(() =>
      BlsConfigSchema.parse({ ...valid.bls, intervalMinSeconds: 30, intervalMaxSeconds: 60 }),
    ).toThrow();
  });

  it('rejects an inverted interval range', () => {
    expect(() =>
      BlsConfigSchema.parse({ ...valid.bls, intervalMinSeconds: 360, intervalMaxSeconds: 180 }),
    ).toThrow();
  });

  it('rejects malformed dates and times', () => {
    expect(() => BlsConfigSchema.parse({ ...valid.bls, preferredDateFrom: '01/10/2026' })).toThrow();
    expect(() => BlsConfigSchema.parse({ ...valid.bls, preferredDateFrom: '2026-02-31' })).toThrow();
    expect(() => BlsConfigSchema.parse({ ...valid.bls, preferredTimeFrom: '9am' })).toThrow();
    expect(() => BlsConfigSchema.parse({ ...valid.bls, preferredTimeFrom: '25:00' })).toThrow();
  });

  it('rejects an inverted date or time window', () => {
    expect(() =>
      BlsConfigSchema.parse({
        ...valid.bls,
        preferredDateFrom: '2026-12-01',
        preferredDateTo: '2026-10-01',
      }),
    ).toThrow();
    expect(() =>
      BlsConfigSchema.parse({
        ...valid.bls,
        preferredTimeFrom: '14:00',
        preferredTimeTo: '09:00',
      }),
    ).toThrow();
  });

  it('accepts a configured window', () => {
    const parsed = BlsConfigSchema.parse({
      ...valid.bls,
      preferredDateFrom: '2026-10-01',
      preferredDateTo: '2026-12-31',
      preferredTimeFrom: '09:00',
      preferredTimeTo: '13:00',
    });
    expect(parsed.preferredDateFrom).toBe('2026-10-01');
    expect(parsed.preferredTimeTo).toBe('13:00');
  });

  it('defaults to a single individual applicant on a short-stay tourist visa', () => {
    const { visaType, visaSubCategory, applicantType, memberCount, ...rest } = valid.bls;
    void visaType;
    void visaSubCategory;
    void applicantType;
    void memberCount;
    const parsed = BlsConfigSchema.parse(rest);
    expect(parsed.visaType).toBe('Short Stay');
    expect(parsed.visaSubCategory).toBe('Tourist');
    expect(parsed.applicantType).toBe('Individual');
    expect(parsed.memberCount).toBe(1);
  });

  it('accepts a family booking with its member count', () => {
    const parsed = BlsConfigSchema.parse({
      ...valid.bls,
      visaType: 'Short Stay',
      visaSubCategory: 'Tourist',
      applicantType: 'Family',
      memberCount: 3,
    });
    expect(parsed.applicantType).toBe('Family');
    expect(parsed.memberCount).toBe(3);
    expect(parsed.visaSubCategory).toBe('Tourist');
  });

  it('rejects a family or group of one', () => {
    expect(() =>
      BlsConfigSchema.parse({ ...valid.bls, applicantType: 'Family', memberCount: 1 }),
    ).toThrow();
    expect(() =>
      BlsConfigSchema.parse({ ...valid.bls, applicantType: 'Group', memberCount: 1 }),
    ).toThrow();
  });

  it('rejects an individual booking with several applicants', () => {
    expect(() =>
      BlsConfigSchema.parse({ ...valid.bls, applicantType: 'Individual', memberCount: 4 }),
    ).toThrow();
  });

  it('rejects an unknown applicant type and an out-of-range count', () => {
    expect(() => BlsConfigSchema.parse({ ...valid.bls, applicantType: 'Company' })).toThrow();
    expect(() =>
      BlsConfigSchema.parse({ ...valid.bls, applicantType: 'Group', memberCount: 99 }),
    ).toThrow();
  });

  it('allows any visa category wording, since BLS renames them', () => {
    expect(BlsConfigSchema.parse({ ...valid.bls, visaType: 'Short Stay / Schengen' }).visaType).toBe(
      'Short Stay / Schengen',
    );
  });
});
