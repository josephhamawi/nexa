import { z } from 'zod';

/**
 * Version 1 is deliberately locked to Spain / Nigeria / Lagos.
 * The literal schemas below are the enforcement point: a config file that
 * tries to monitor Abuja (or any other centre) fails validation instead of
 * silently monitoring the wrong place.
 */
export const LAGOS = 'Lagos' as const;

/** Strict calendar check, Date.parse alone silently rolls 2026-02-31 over. */
function isRealDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine(isRealDate, 'not a real calendar date');

const timeString = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

/** Empty string means "unset / no filter". */
const optionalDate = z.union([z.literal(''), dateString]).default('');
const optionalTime = z.union([z.literal(''), timeString]).default('');

export const BlsConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    country: z.literal('Spain').default('Spain'),
    applicationCountry: z.literal('Nigeria').default('Nigeria'),
    city: z.literal(LAGOS).default(LAGOS),
    centre: z.literal(LAGOS).default(LAGOS),
    /**
     * Free text, matched case-insensitively against whatever the BLS portal
     * currently calls the category (e.g. "Tourist", "Short Stay", "Schengen").
     * Never hard-coded into selectors.
     */
    visaType: z.string().min(1).default('Short Stay'),
    /**
     * Second-level category, when BLS shows one (e.g. visa type "Short Stay"
     * with sub-category "Tourist"). Empty means "the portal only asks once".
     */
    visaSubCategory: z.string().default('Tourist'),
    /** Who the appointment is for. BLS prices and schedules these differently. */
    applicantType: z.enum(['Individual', 'Family', 'Group']).default('Individual'),
    /** Number of applicants. Only meaningful for Family / Group. */
    memberCount: z.number().int().min(1).max(20).default(1),
    preferredDateFrom: optionalDate,
    preferredDateTo: optionalDate,
    preferredTimeFrom: optionalTime,
    preferredTimeTo: optionalTime,
    /** Politeness floor. Anything under 180s is rejected, not clamped silently. */
    intervalMinSeconds: z.number().int().min(180).max(7200).default(180),
    intervalMaxSeconds: z.number().int().min(180).max(7200).default(360),
    /** Cooldown enforced on the dashboard's CHECK NOW button. */
    manualCheckCooldownSeconds: z.number().int().min(30).max(3600).default(90),
    /** Show the Playwright window. Headless is possible but discouraged: you
     *  cannot complete a CAPTCHA you cannot see. */
    headless: z.boolean().default(false),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.intervalMaxSeconds < cfg.intervalMinSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['intervalMaxSeconds'],
        message: 'intervalMaxSeconds must be >= intervalMinSeconds',
      });
    }
    if (cfg.preferredDateFrom && cfg.preferredDateTo && cfg.preferredDateTo < cfg.preferredDateFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preferredDateTo'],
        message: 'preferredDateTo must be on or after preferredDateFrom',
      });
    }
    if (cfg.applicantType === 'Individual' && cfg.memberCount !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memberCount'],
        message: 'an Individual appointment is always 1 applicant',
      });
    }
    if (cfg.applicantType !== 'Individual' && cfg.memberCount < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['memberCount'],
        message: `a ${cfg.applicantType} appointment needs at least 2 applicants`,
      });
    }
    if (cfg.preferredTimeFrom && cfg.preferredTimeTo && cfg.preferredTimeTo < cfg.preferredTimeFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preferredTimeTo'],
        message: 'preferredTimeTo must be on or after preferredTimeFrom',
      });
    }
  });

export const NotificationsConfigSchema = z.object({
  telegram: z.boolean().default(true),
  desktop: z.boolean().default(true),
  sound: z.boolean().default(true),
});

export const AppConfigSchema = z.object({
  bls: BlsConfigSchema,
  notifications: NotificationsConfigSchema.default({
    telegram: true,
    desktop: true,
    sound: true,
  }),
});

export type BlsConfig = z.infer<typeof BlsConfigSchema>;
export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().optional(),
  TELEGRAM_CHAT_ID: z.string().trim().optional(),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof EnvSchema>;
