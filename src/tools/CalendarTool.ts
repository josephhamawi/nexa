import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { CalendarConfig } from '../config/schema';
import { childLogger } from '../logging/logger';
import {
  APPLE_EVENT_TIMEOUT_SECONDS,
  explainAppleScriptError,
  missingTarget,
  requireMac,
  runOsascript,
  splitOnce,
  type ScriptRunner,
} from './applescript';

const log = childLogger('tool:calendar');

const InputSchema = z.object({
  operation: z.enum(['create', 'list_calendars']).default('create'),
  /** create only. What the event is called. */
  title: z.string().trim().min(1).max(200).default(''),
  /**
   * create only. Absolute start time, ISO 8601, e.g. "2026-09-22T14:00:00Z"
   * or "2026-09-22T14:00:00+03:00". Relative phrasing is not accepted: the
   * planner must resolve "tomorrow at 3" to a real instant first.
   */
  startsAt: z.string().trim().default(''),
  /** create only. Length of the event in minutes. */
  durationMinutes: z.number().int().min(5).max(1440).default(60),
  /** Which calendar to write to. Empty uses the configured default. */
  calendarName: z.string().trim().max(120).default(''),
  /** create only. Free text stored on the event. */
  notes: z.string().max(2000).default(''),
});

type Input = z.infer<typeof InputSchema>;

/**
 * Creates events in the macOS Calendar app.
 *
 * Nexa's first tool that changes something outside itself, so it is built the
 * way every later action tool should be:
 *
 * - `mutating` is true, which routes it through the approval gate before it
 *   ever runs (TaskEngine checks this against requireApprovalForWrites).
 * - Every value reaches AppleScript as an `argv` item, never interpolated into
 *   the script text. An event titled `" & (do shell script "rm -rf ~") & "`
 *   is stored as that literal string and nothing else.
 * - Creating is idempotent on (title, start time): a retry after a timeout
 *   finds the event it already made and reports it instead of double-booking.
 */
export class CalendarTool implements Tool<Input> {
  readonly name = 'calendar';
  readonly description =
    'Create an event in the macOS Calendar, or list the available calendars. ' +
    'Input: {operation: "create"|"list_calendars", title, startsAt (ISO 8601 with a timezone, e.g. "2026-09-22T14:00:00Z"), ' +
    'durationMinutes, calendarName, notes}. Resolve relative times like "tomorrow at 3" into startsAt yourself; ' +
    'this tool does not parse them.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.CALENDAR];
  readonly mutating = true;

  constructor(
    private readonly config: () => CalendarConfig,
    /** Injected so tests do not need a real Calendar.app. */
    private readonly run: ScriptRunner = runOsascript,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const { enabled, defaultCalendar } = this.config();

    if (!enabled) {
      return {
        ok: false,
        summary: 'Calendar access is off',
        error: 'Turn on calendar access under Settings before asking for events.',
      };
    }

    const notMac = requireMac('Writing calendar events');
    if (notMac) return notMac;

    try {
      if (input.operation === 'list_calendars') return await this.listCalendars(context);
      return await this.create(input, defaultCalendar, context);
    } catch (err) {
      return this.explain(err as Error, input);
    }
  }

  private async listCalendars(context: ToolContext): Promise<ToolResult> {
    const output = await this.run(LIST_SCRIPT, []);
    const names = output.split('\n').map((line) => line.trim()).filter(Boolean);

    context.report(`Found ${names.length} calendar(s)`);
    return {
      ok: true,
      summary: names.length > 0 ? `Calendars: ${names.join(', ')}` : 'No calendars found',
      data: { calendars: names },
    };
  }

  private async create(input: Input, defaultCalendar: string, context: ToolContext): Promise<ToolResult> {
    if (!input.title) {
      return { ok: false, summary: 'The event needs a title', error: 'title is required for operation "create"' };
    }

    const startsAt = parseInstant(input.startsAt);
    if (!startsAt) {
      return {
        ok: false,
        summary: 'That start time is not a real instant',
        error:
          `startsAt must be an ISO 8601 timestamp with a date and time, such as "2026-09-22T14:00:00Z". ` +
          `Got "${input.startsAt}".`,
      };
    }

    const calendarName = input.calendarName || defaultCalendar;
    if (!calendarName) {
      return {
        ok: false,
        summary: 'No calendar chosen',
        error: 'Set a default calendar under Settings, or pass calendarName. Use operation "list_calendars" to see them.',
      };
    }

    const epochSeconds = Math.floor(startsAt.getTime() / 1000);
    const output = await this.run(CREATE_SCRIPT, [
      calendarName,
      input.title,
      String(epochSeconds),
      String(input.durationMinutes),
      input.notes,
    ]);

    const [outcome, uid = ''] = splitOnce(output.trim(), ':');
    const when = startsAt.toISOString();
    const duplicate = outcome === 'duplicate';

    context.report(duplicate ? `Event already existed: ${input.title}` : `Created "${input.title}"`);
    context.addEvidence({
      kind: 'data',
      title: `Calendar: ${input.title}`,
      summary: `${when} for ${input.durationMinutes} min in "${calendarName}"${duplicate ? ' (already existed)' : ''}`,
    });
    log.info({ calendarName, duplicate }, 'calendar event written');

    return {
      ok: true,
      summary: duplicate
        ? `"${input.title}" was already in ${calendarName} at ${when}, so nothing was added`
        : `Added "${input.title}" to ${calendarName} at ${when} for ${input.durationMinutes} min`,
      data: { uid, title: input.title, startsAt: when, durationMinutes: input.durationMinutes, calendarName, duplicate },
    };
  }

  /**
   * Turns an osascript failure into something the model and the user can both
   * act on. A bare "execution error: -1743" tells neither of them anything.
   */
  private explain(err: Error, input: Input): ToolResult {
    const message = err.message;

    const shared = explainAppleScriptError(message, 'Calendar');
    if (shared) return shared;

    const missing = missingTarget(message, 'no-calendar');
    if (missing) {
      return {
        ok: false,
        summary: `There is no calendar called "${missing}"`,
        error: `Calendar "${missing}" does not exist. Run operation "list_calendars" to see the real names.`,
      };
    }

    log.warn({ err: message, operation: input.operation }, 'calendar operation failed');
    return { ok: false, summary: 'The calendar operation failed', error: message.slice(0, 500) };
  }
}

/**
 * Both scripts take every value through `argv`. Nothing the model produces is
 * ever concatenated into the script source, so there is no string a title or a
 * note could contain that would change what the script does.
 */
const LIST_SCRIPT = `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Calendar"
		set out to ""
		repeat with c in calendars
			set out to out & (name of c) & linefeed
		end repeat
		return out
	end tell
end timeout
`;

const CREATE_SCRIPT = `
on run argv
	set calName to item 1 of argv
	set evTitle to item 2 of argv
	set startEpoch to (item 3 of argv) as integer
	set durMin to (item 4 of argv) as integer
	set evNotes to item 5 of argv

	-- AppleScript has no epoch constructor, so anchor "now" and offset from it.
	set nowEpoch to (do shell script "date +%s") as integer
	set startDate to (current date) - nowEpoch + startEpoch
	set endDate to startDate + (durMin * 60)

	with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Calendar"
		set theCal to missing value
		repeat with c in calendars
			if (name of c as string) is calName then
				set theCal to c
				exit repeat
			end if
		end repeat
		if theCal is missing value then error "no-calendar:" & calName

		-- Idempotency: a retry after a timeout must not book the same slot twice.
		repeat with e in (every event of theCal whose summary is evTitle)
			if (start date of e) is startDate then return "duplicate:" & (uid of e)
		end repeat

		set newEvent to make new event at end of events of theCal with properties {summary:evTitle, start date:startDate, end date:endDate, description:evNotes}
		return "created:" & (uid of newEvent)
	end tell
	end timeout
end run
`;

/** Accepts an ISO 8601 instant and nothing else. "tomorrow" is not a time. */
export function parseInstant(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

