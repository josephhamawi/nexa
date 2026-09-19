import { describe, expect, it } from 'vitest';
import { Planner, extractUrl, parseRecurrence, extractTimeOfDay, hostOf } from '../src/agent/Planner';
import { NullProvider } from '../src/llm/providers';
import { ToolRegistry } from '../src/tools/Tool';
import { WatcherTool } from '../src/tools/WatcherTool';
import { AnalysisTool } from '../src/tools/AnalysisTool';
import { WebResearchTool } from '../src/tools/WebResearchTool';
import { NotifyTool } from '../src/tools/NotifyTool';
import { NotificationManager } from '../src/notifications/NotificationManager';
import { UserProfileSchema } from '../src/config/schema';

function context() {
  const llm = new NullProvider();
  const tools = new ToolRegistry();
  tools.register(new WebResearchTool(llm, () => true));
  tools.register(new AnalysisTool(llm, () => UserProfileSchema.parse({})));
  tools.register(
    new WatcherTool({
      create: (input) => ({ ...input, id: 'w1' }) as never,
      list: () => [],
      setStatus: () => undefined,
      remove: () => false,
      minIntervalSeconds: () => 300,
    }),
  );
  tools.register(
    new NotifyTool(new NotificationManager({ telegram: false, desktop: false, sound: false, dailyBriefAt: '' }), llm),
  );

  return {
    profile: UserProfileSchema.parse({ preferredRoles: ['AI engineer'], remotePreference: 'remote' as const }),
    tools,
    defaultWatchIntervalSeconds: 21_600,
  };
}

const planner = new Planner(new NullProvider());

describe('control intents', () => {
  it('recognises status and listing phrases', () => {
    expect(planner.detectControl('/status')?.action).toBe('status');
    expect(planner.detectControl('show me my active tasks')?.action).toBe('list_tasks');
    expect(planner.detectControl('show my watchers')?.action).toBe('list_watchers');
    expect(planner.detectControl('/help')?.action).toBe('help');
  });

  it('recognises pause, resume and cancel with a target', () => {
    expect(planner.detectControl('pause the job search')).toEqual({ action: 'pause', target: 'job search' });
    expect(planner.detectControl('resume the job search')).toEqual({ action: 'resume', target: 'job search' });
    expect(planner.detectControl('cancel the pricing watcher')).toEqual({ action: 'cancel', target: 'pricing watcher' });
    expect(planner.detectControl('stop everything')?.action).toBe('stop_all');
  });

  it('leaves real work alone', () => {
    expect(planner.detectControl('research the latest AI agent frameworks')).toBeNull();
    expect(planner.detectControl('find me 5 remote jobs')).toBeNull();
  });
});

describe('rule-based planning', () => {
  it('turns a watch request into a watcher task', async () => {
    const plan = await planner.plan('watch https://example.com/pricing and tell me when the price changes', context());
    expect(plan.type).toBe('WATCH');
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].tool).toBe('watcher');
    expect(plan.steps[0].input.target).toBe('https://example.com/pricing');
    expect(plan.method).toBe('rules');
  });

  it('turns a research request into search, analyse, report', async () => {
    const plan = await planner.plan('research the latest AI agent frameworks', context());
    expect(plan.type).toBe('RESEARCH');
    expect(plan.steps.map((s) => s.tool)).toEqual(['web_research', 'analyze', 'notify']);
    expect(plan.permissions).toContain('RESEARCH');
    expect(plan.permissions).toContain('NOTIFY');
  });

  it('uses the profile for job requests and honours a count', async () => {
    const plan = await planner.plan('find me 5 remote AI jobs', context());
    expect(plan.steps[1].input.useProfile).toBe(true);
    expect(plan.steps[1].input.limit).toBe(5);
    expect(String(plan.steps[0].input.query)).toMatch(/AI engineer/);
  });

  it('asks for approval before a workflow that logs in', async () => {
    const plan = await planner.plan('open https://example.com and log in, then collect the dashboard', context());
    expect(plan.type).toBe('BROWSER_WORKFLOW');
    expect(plan.approvalRequired).toBe(true);
    expect(plan.permissions).toContain('BROWSER');
  });

  it('picks up a recurring schedule', async () => {
    const plan = await planner.plan('every morning at 8am research AI news and send it to me', context());
    expect(plan.recurrence).toEqual({ kind: 'daily', at: '08:00' });
  });

  it('only grants permissions the chosen tools need', async () => {
    const plan = await planner.plan('watch https://example.com for changes', context());
    expect(plan.permissions).not.toContain('FILES');
    expect(plan.permissions).not.toContain('BROWSER');
  });
});

describe('parsing helpers', () => {
  it('finds urls, including bare domains', () => {
    expect(extractUrl('watch https://example.com/pricing please')).toBe('https://example.com/pricing');
    expect(extractUrl('monitor example.com/jobs')).toBe('https://example.com/jobs');
    expect(extractUrl('no link here')).toBeNull();
  });

  it('reads schedules', () => {
    expect(parseRecurrence('every 6 hours')).toEqual({ kind: 'interval', everySeconds: 21_600 });
    expect(parseRecurrence('every day at 07:30')).toEqual({ kind: 'daily', at: '07:30' });
    expect(parseRecurrence('every friday')).toEqual({ kind: 'weekly', weekday: 5, at: '08:00' });
    expect(parseRecurrence('just once')).toEqual({ kind: 'once' });
  });

  it('raises a too-short interval to the floor', () => {
    expect(parseRecurrence('every 2 minutes')).toEqual({ kind: 'interval', everySeconds: 300 });
  });

  it('reads times of day', () => {
    expect(extractTimeOfDay('at 8am')).toBe('08:00');
    expect(extractTimeOfDay('at 7:45 pm')).toBe('19:45');
    expect(extractTimeOfDay('no time')).toBeNull();
  });

  it('shortens hosts for titles', () => {
    expect(hostOf('https://www.example.com/a/b')).toBe('example.com');
  });
});

describe('task titles', () => {
  it('drops scheduling scaffolding from the name', async () => {
    const plan = await planner.plan('every morning at 8am research AI news', context());
    // Both the schedule and the leading verb are scaffolding, not the subject.
    expect(plan.name).toBe('AI news');
    expect(plan.recurrence).toEqual({ kind: 'daily', at: '08:00' });
  });

  it('keeps the original request verbatim for auditing', async () => {
    const plan = await planner.plan('every morning at 8am research AI news', context());
    expect(plan.description).toContain('every morning at 8am');
  });
});

describe('capability honesty', () => {
  it('refuses actions Nexa has no tool for, rather than searching the web', () => {
    for (const request of [
      'add to my calendar a meeting tomorrow',
      'schedule a meeting with the team on Friday',
      'send an email to john@example.com',
      'buy me a domain name',
      'post this on linkedin',
      'apply to that job for me',
    ]) {
      expect(planner.detectUnsupported(request), request).not.toBeNull();
    }
  });

  it('still treats a research question as research even when it mentions those verbs', () => {
    for (const request of [
      'research how to buy a domain name',
      'find me the best calendar apps',
      'what is the cheapest way to send email at scale',
      'compare tools for scheduling meetings',
    ]) {
      expect(planner.detectUnsupported(request), request).toBeNull();
    }
  });

  it('produces a plan with no steps so nothing is executed', async () => {
    const plan = await planner.plan('add to my calendar a meeting tomorrow', context());
    expect(plan.unsupported?.capability).toBe('calendar');
    expect(plan.steps).toHaveLength(0);
  });

  it('leaves supported work alone', () => {
    expect(planner.detectUnsupported('watch https://example.com for changes')).toBeNull();
    expect(planner.detectUnsupported('research AI agent frameworks')).toBeNull();
  });
});
