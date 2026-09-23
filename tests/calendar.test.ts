import { describe, expect, it, vi } from 'vitest';
import { CalendarTool, parseInstant } from '../src/tools/CalendarTool';
import { Permission, createTask, makeStep, TaskType } from '../src/tasks/Task';

function context() {
  const task = createTask({ name: 't', naturalLanguageRequest: 'r', type: TaskType.RESEARCH });
  const step = makeStep('calendar', 'step');
  return {
    task: { ...task, steps: [step] },
    step,
    report: vi.fn(),
    addEvidence: vi.fn((input) => ({ id: 'e', taskId: task.id, stepId: step.id, at: '', ...input })),
  };
}

const on = { enabled: true, defaultCalendar: 'Home' };

function input(overrides: Record<string, unknown> = {}) {
  return {
    operation: 'create' as const,
    title: 'Dentist',
    startsAt: '2026-09-22T14:00:00Z',
    durationMinutes: 60,
    calendarName: '',
    notes: '',
    ...overrides,
  };
}

/** Every test runs on the macOS path; the platform guard is covered separately. */
const darwin = (): void => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
};

describe('calendar tool', () => {
  it('is mutating, so it goes through the approval gate', () => {
    const tool = new CalendarTool(() => on, async () => 'created:x');
    expect(tool.mutating).toBe(true);
    expect(tool.permissions).toEqual([Permission.CALENDAR]);
  });

  it('refuses when calendar access is switched off', async () => {
    const tool = new CalendarTool(() => ({ enabled: false, defaultCalendar: 'Home' }), async () => 'created:x');
    const result = await tool.execute(input(), context() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/turn on calendar access/i);
  });

  it('creates an event and reports where it went', async () => {
    darwin();
    const run = vi.fn(async () => 'created:ABC-123\n');
    const ctx = context();
    const result = await new CalendarTool(() => on, run).execute(input(), ctx as never);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Added "Dentist" to Home/);
    expect((result.data as { uid: string }).uid).toBe('ABC-123');
    expect(ctx.addEvidence).toHaveBeenCalled();
  });

  it('passes the start time as epoch seconds, not as text', async () => {
    darwin();
    const run = vi.fn(async () => 'created:x');
    await new CalendarTool(() => on, run).execute(input(), context() as never);

    const args = run.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('Home');
    expect(args[1]).toBe('Dentist');
    expect(args[2]).toBe(String(Date.UTC(2026, 8, 22, 14, 0, 0) / 1000));
    expect(args[3]).toBe('60');
  });

  it('hands a hostile title to AppleScript as data, never as script', async () => {
    darwin();
    const run = vi.fn(async () => 'created:x');
    const nasty = '" & (do shell script "rm -rf ~") & "';
    await new CalendarTool(() => on, run).execute(input({ title: nasty }), context() as never);

    const [script, args] = run.mock.calls[0] as [string, string[]];
    expect(args[1]).toBe(nasty);
    expect(script).not.toContain('rm -rf');
  });

  it('does not double-book when a retry finds the event already there', async () => {
    darwin();
    const tool = new CalendarTool(() => on, async () => 'duplicate:EXISTING');
    const result = await tool.execute(input(), context() as never);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/already in Home/);
    expect((result.data as { duplicate: boolean }).duplicate).toBe(true);
  });

  it('rejects a relative time instead of guessing at one', async () => {
    darwin();
    const run = vi.fn(async () => 'created:x');
    const result = await new CalendarTool(() => on, run).execute(
      input({ startsAt: 'tomorrow at 3' }),
      context() as never,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ISO 8601/);
    expect(run).not.toHaveBeenCalled();
  });

  it('asks for a calendar name when there is no default', async () => {
    darwin();
    const tool = new CalendarTool(() => ({ enabled: true, defaultCalendar: '' }), async () => 'created:x');
    const result = await tool.execute(input(), context() as never);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/list_calendars/);
  });

  it('stops for a human when macOS blocks automation', async () => {
    darwin();
    const tool = new CalendarTool(() => on, async () => {
      throw new Error('execution error: Not authorized to send Apple events to Calendar. (-1743)');
    });
    const result = await tool.execute(input(), context() as never);

    expect(result.ok).toBe(false);
    expect(result.needsHuman?.reason).toMatch(/Privacy & Security/);
  });

  it('stops for a human when Calendar never answers, rather than looping on "try again"', async () => {
    darwin();
    const tool = new CalendarTool(() => on, async () => {
      throw new Error('45:125: execution error: Calendar got an error: AppleEvent timed out. (-1712)');
    });
    const result = await tool.execute(input(), context() as never);

    expect(result.ok).toBe(false);
    expect(result.needsHuman?.reason).toMatch(/permission prompt|mid-sync/i);
  });

  it('wraps its Calendar work in an AppleScript timeout', async () => {
    darwin();
    const run = vi.fn(async () => 'created:x');
    await new CalendarTool(() => on, run).execute(input(), context() as never);

    const script = run.mock.calls[0]?.[0] as string;
    expect(script).toMatch(/with timeout of \d+ seconds/);
    expect(script).not.toContain('${');
  });

  it('names the real calendars when the one asked for does not exist', async () => {
    darwin();
    const tool = new CalendarTool(() => on, async () => {
      throw new Error('script error: no-calendar:Wrok');
    });
    const result = await tool.execute(input({ calendarName: 'Wrok' }), context() as never);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no calendar called "Wrok"/i);
    expect(result.error).toMatch(/list_calendars/);
  });

  it('lists calendars', async () => {
    darwin();
    const tool = new CalendarTool(() => on, async () => 'Home\nWork\n\n');
    const result = await tool.execute(input({ operation: 'list_calendars' }), context() as never);

    expect(result.ok).toBe(true);
    expect((result.data as { calendars: string[] }).calendars).toEqual(['Home', 'Work']);
  });

  it('says so plainly when it is not on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const run = vi.fn(async () => 'created:x');
    const result = await new CalendarTool(() => on, run).execute(input(), context() as never);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/macOS/);
    expect(run).not.toHaveBeenCalled();
    darwin();
  });
});

describe('parseInstant', () => {
  it('accepts ISO 8601 instants', () => {
    expect(parseInstant('2026-09-22T14:00:00Z')?.toISOString()).toBe('2026-09-22T14:00:00.000Z');
    expect(parseInstant('2026-09-22T14:00:00+03:00')?.toISOString()).toBe('2026-09-22T11:00:00.000Z');
  });

  it('refuses phrases, bare dates and nonsense', () => {
    expect(parseInstant('tomorrow at 3')).toBeNull();
    expect(parseInstant('2026-09-22')).toBeNull();
    expect(parseInstant('')).toBeNull();
    expect(parseInstant('2026-13-45T99:00:00Z')).toBeNull();
  });
});
