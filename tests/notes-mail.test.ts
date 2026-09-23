import { describe, expect, it, vi } from 'vitest';
import { NotesTool, toHtml } from '../src/tools/NotesTool';
import { MailTool, isEmailAddress } from '../src/tools/MailTool';
import { MailReadTool, type MailAccount, type MailMessage } from '../src/tools/MailReadTool';
import { Permission, createTask, makeStep, TaskType } from '../src/tasks/Task';

function context() {
  const task = createTask({ name: 't', naturalLanguageRequest: 'r', type: TaskType.RESEARCH });
  const step = makeStep('x', 'step');
  return {
    task: { ...task, steps: [step] },
    step,
    report: vi.fn(),
    addEvidence: vi.fn((input) => ({ id: 'e', taskId: task.id, stepId: step.id, at: '', ...input })),
  };
}

const darwin = (): void => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
};

describe('notes tool', () => {
  const on = { enabled: true, defaultFolder: 'Notes' };
  const note = { operation: 'create' as const, title: 'Shortlist', body: 'one\ntwo', folder: '' };

  it('is mutating and asks for its own permission', () => {
    const tool = new NotesTool(() => on, async () => 'created:x');
    expect(tool.mutating).toBe(true);
    expect(tool.permissions).toEqual([Permission.NOTES]);
  });

  it('refuses while notes access is off', async () => {
    const tool = new NotesTool(() => ({ enabled: false, defaultFolder: 'Notes' }), async () => 'created:x');
    const result = await tool.execute(note, context() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/turn on notes access/i);
  });

  it('saves a note and says where it went', async () => {
    darwin();
    const ctx = context();
    const result = await new NotesTool(() => on, async () => 'created:Shortlist').execute(note, ctx as never);

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Saved "Shortlist" to Notes/);
    expect(ctx.addEvidence).toHaveBeenCalled();
  });

  it('does not leave two copies when a retry finds the note already there', async () => {
    darwin();
    const result = await new NotesTool(() => on, async () => 'duplicate:Shortlist').execute(note, context() as never);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/already in Notes/);
  });

  it('passes the body as argv, never as script', async () => {
    darwin();
    const run = vi.fn(async () => 'created:x');
    const nasty = '" & (do shell script "rm -rf ~") & "';
    await new NotesTool(() => on, run).execute({ ...note, title: nasty }, context() as never);

    const [script, args] = run.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe(nasty);
    expect(script).not.toContain('rm -rf');
  });

  it('points at the real folders when the one asked for is missing', async () => {
    darwin();
    const tool = new NotesTool(() => on, async () => {
      throw new Error('script error: no-folder:Wrok');
    });
    const result = await tool.execute({ ...note, folder: 'Wrok' }, context() as never);
    expect(result.summary).toMatch(/no Notes folder called "Wrok"/i);
    expect(result.error).toMatch(/list_folders/);
  });

  it('stops for a human when macOS blocks automation', async () => {
    darwin();
    const tool = new NotesTool(() => on, async () => {
      throw new Error('execution error: Not authorized to send Apple events to Notes. (-1743)');
    });
    const result = await tool.execute(note, context() as never);
    expect(result.needsHuman?.reason).toMatch(/Privacy & Security/);
  });
});

describe('note body escaping', () => {
  it('keeps markup readable as text instead of letting it become markup', () => {
    const html = toHtml('Plan', '<script>alert(1)</script>\nsecond line');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('<h1>Plan</h1>');
  });

  it('keeps blank lines', () => {
    expect(toHtml('t', 'a\n\nb')).toContain('<br>');
  });
});

describe('mail tool', () => {
  const draftOnly = { enabled: true, allowSend: false };
  const canSend = { enabled: true, allowSend: true };
  const mail = { operation: 'draft' as const, to: ['a@example.com'], subject: 'Hello', body: 'Hi there' };

  it('is mutating and asks for its own permission', () => {
    const tool = new MailTool(() => draftOnly, async () => 'drafted:x');
    expect(tool.mutating).toBe(true);
    expect(tool.permissions).toEqual([Permission.MAIL]);
  });

  it('drafts by default and tells the user it is waiting in Drafts', async () => {
    darwin();
    const result = await new MailTool(() => draftOnly, async () => 'drafted:Hello').execute(
      mail,
      context() as never,
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/Drafts/);
    expect((result.data as { sent: boolean }).sent).toBe(false);
  });

  it('refuses to send while sending is switched off, rather than drafting quietly', async () => {
    darwin();
    const run = vi.fn(async () => 'sent:Hello');
    const result = await new MailTool(() => draftOnly, run).execute(
      { ...mail, operation: 'send' },
      context() as never,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Sending is switched off/);
    expect(run).not.toHaveBeenCalled();
  });

  it('sends once sending has been switched on', async () => {
    darwin();
    const run = vi.fn(async () => 'sent:Hello');
    const result = await new MailTool(() => canSend, run).execute(
      { ...mail, operation: 'send' },
      context() as never,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/^Sent "Hello"/);
    expect((run.mock.calls[0]?.[1] as string[])[3]).toBe('send');
  });

  it('rejects a hallucinated recipient instead of addressing mail to a phrase', async () => {
    darwin();
    const run = vi.fn(async () => 'drafted:x');
    const result = await new MailTool(() => draftOnly, run).execute(
      { ...mail, to: ['the hiring manager', 'ok@example.com'] },
      context() as never,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/the hiring manager/);
    expect(run).not.toHaveBeenCalled();
  });

  it('says so when Mail has no account configured', async () => {
    darwin();
    const tool = new MailTool(() => draftOnly, async () => {
      throw new Error('script error: no-account');
    });
    const result = await tool.execute(mail, context() as never);
    expect(result.summary).toMatch(/no account set up/i);
  });

  it('passes recipients and subject as argv, never as script', async () => {
    darwin();
    const run = vi.fn(async () => 'drafted:x');
    const nasty = '" & (do shell script "rm -rf ~") & "';
    await new MailTool(() => draftOnly, run).execute({ ...mail, subject: nasty }, context() as never);

    const [script, args] = run.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe(nasty);
    expect(script).not.toContain('rm -rf');
  });
});

describe('email address validation', () => {
  it('accepts real addresses', () => {
    expect(isEmailAddress('a.b+tag@sub.example.co.uk')).toBe(true);
  });

  it('rejects phrases, bare names and injected separators', () => {
    for (const bad of ['the hiring manager', 'a@b', 'a@b.c', '', 'a@b.com, c@d.com', '<a@b.com>']) {
      expect(isEmailAddress(bad)).toBe(false);
    }
  });
});

interface InboxData {
  items: MailMessage[];
  count: number;
  account: string;
}

describe('mail read tool', () => {
  const on = { enabled: true, allowSend: false, defaultAccount: '', accounts: [] };
  const UNIT = String.fromCharCode(31);
  const RECORD = String.fromCharCode(30);

  const row = (subject, sender, date, read, account = 'iCloud', preview = '') =>
    [subject, sender, date, read, account, preview].join(UNIT) + RECORD;

  const input = (overrides = {}) => ({
    operation: 'read',
    account: '',
    sinceHours: 24,
    maxSeconds: 60,
    unreadOnly: true,
    maxMessages: 20,
    includePreview: false,
    ...overrides,
  });

  it('reads without asking for approval, unlike sending', () => {
    const tool = new MailReadTool(() => on, async () => '');
    expect(tool.mutating).toBe(false);
    expect(tool.permissions).toEqual([Permission.MAIL_READ]);
  });

  it('does not borrow the grant that lets Nexa write mail', () => {
    const read = new MailReadTool(() => on, async () => '');
    const write = new MailTool(() => on, async () => 'drafted:x');
    expect(read.permissions).not.toEqual(write.permissions);
  });

  it('refuses while mail access is off', async () => {
    const tool = new MailReadTool(() => ({ enabled: false, allowSend: false }), async () => '');
    const result = await tool.execute(input(), context() as never);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/turn on mail/i);
  });

  it('returns what arrived, parsed into records', async () => {
    darwin();
    const output =
      row('Invoice #42', 'billing@acme.com', 'Saturday 20 September 2026 at 09:14:00', 'false') +
      row('Re: interview', 'hr@corp.io', 'Saturday 20 September 2026 at 11:02:00', 'false');

    const ctx = context() as never;
    const result = await new MailReadTool(() => on, async () => output).execute(input(), ctx);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe('2 unread message(s) today');
    const items = (result.data as InboxData).items;
    expect(items).toHaveLength(2);
    expect(items[0].subject).toBe('Invoice #42');
    expect(items[0].sender).toBe('billing@acme.com');
    expect(items[0].read).toBe(false);
    expect(ctx.addEvidence).toHaveBeenCalled();
  });

  it('says the inbox is empty rather than reporting zero results', async () => {
    darwin();
    const result = await new MailReadTool(() => on, async () => '').execute(input(), context() as never);
    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/^No unread mail today\./);
    expect((result.data as InboxData).count).toBe(0);
  });

  it('does not assert an empty inbox, since Mail may not have synced yet', async () => {
    darwin();
    // A message delivered two minutes ago may not be in Mail's local store,
    // which is what made a real "summarize today's mail" come back with zero
    // while six messages sat in the account.
    const result = await new MailReadTool(() => on, async () => 'complete' + RECORD).execute(
      input(),
      context() as never,
    );
    expect(result.summary).toMatch(/not yet synced/);
  });

  it('passes the window, mode and caps through to the script', async () => {
    darwin();
    const run = vi.fn(async () => '');
    await new MailReadTool(() => on, run).execute(
      input({ sinceHours: 72, unreadOnly: false, maxMessages: 5, includePreview: true }),
      context() as never,
    );

    const args = run.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe('72');
    expect(args[1]).toBe('all');
    expect(args[2]).toBe('5');
    expect(args[3]).toBe('preview');
    expect(args[4]).toBe(''); // no account named, so read them all
  });

  it('keeps a subject containing commas and tabs intact', async () => {
    darwin();
    const nasty = 'Re: budget, Q3\tand Q4';
    const output = row(nasty, 'a@b.com', 'today', 'true');
    const result = await new MailReadTool(() => on, async () => output).execute(input(), context() as never);
    expect((result.data as InboxData).items[0].subject).toBe(nasty.trim());
  });

  it('labels a message with no subject instead of leaving it blank', async () => {
    darwin();
    const result = await new MailReadTool(() => on, async () => row('', 'a@b.com', 'today', 'false')).execute(
      input(),
      context() as never,
    );
    expect((result.data as InboxData).items[0].subject).toBe('(no subject)');
  });

  it('caps a preview so one long email cannot flood the context', async () => {
    darwin();
    const output = row('Long', 'a@b.com', 'today', 'false', 'iCloud', 'y'.repeat(5000));
    const result = await new MailReadTool(() => on, async () => output).execute(
      input({ includePreview: true }),
      context() as never,
    );
    expect((result.data as InboxData).items[0].preview.length).toBeLessThanOrEqual(200);
  });

  it('attributes every message to the account it landed in', async () => {
    darwin();
    const output =
      row('a', 'x@y.com', 'today', 'false', 'iCloud') +
      row('b', 'z@w.com', 'today', 'false', 'joseph@outlook.com');
    const result = await new MailReadTool(() => on, async () => output).execute(input(), context() as never);

    expect((result.data as InboxData).items.map((m) => m.account)).toEqual(['iCloud', 'joseph@outlook.com']);
  });

  it('passes a named account through and says which inbox it read', async () => {
    darwin();
    const run = vi.fn(async () => row('a', 'x@y.com', 'today', 'false', 'Work'));
    const result = await new MailReadTool(() => on, run).execute(
      input({ account: 'Work' }),
      context() as never,
    );

    expect((run.mock.calls[0]?.[1] as string[])[4]).toBe('Work');
    expect(result.summary).toMatch(/in Work/);
  });

  it('falls back to the configured default account', async () => {
    darwin();
    const run = vi.fn(async () => '');
    await new MailReadTool(() => ({ ...on, defaultAccount: 'iCloud' }), run).execute(
      input(),
      context() as never,
    );
    expect((run.mock.calls[0]?.[1] as string[])[4]).toBe('iCloud');
  });

  it('does not report an empty inbox when the account name was simply wrong', async () => {
    darwin();
    // Saying "no mail today" here would send someone hunting for lost email.
    const run = vi.fn(async (script: string) =>
      script.includes('on run argv') ? '' : ['iCloud', 'a@b.com', 'true'].join(UNIT) + RECORD,
    );
    const result = await new MailReadTool(() => on, run).execute(
      input({ account: 'Wrok' }),
      context() as never,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no mail account called "Wrok"/i);
    expect(result.error).toMatch(/iCloud/);
  });

  it('does report an empty inbox when the account was right', async () => {
    darwin();
    const run = vi.fn(async (script: string) =>
      script.includes('on run argv') ? '' : ['iCloud', 'a@b.com', 'true'].join(UNIT) + RECORD,
    );
    const result = await new MailReadTool(() => on, run).execute(
      input({ account: 'iCloud' }),
      context() as never,
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toMatch(/No unread mail today in iCloud/);
  });

  it('lists the accounts with their addresses', async () => {
    darwin();
    const output =
      ['iCloud', 'me@icloud.com', 'true'].join(UNIT) + RECORD +
      ['Work', 'me@work.com, alias@work.com', 'true'].join(UNIT) + RECORD;
    const result = await new MailReadTool(() => on, async () => output).execute(
      input({ operation: 'list_accounts' }),
      context() as never,
    );

    expect(result.ok).toBe(true);
    const accounts = (result.data as { accounts: MailAccount[] }).accounts;
    expect(accounts.map((a) => a.name)).toEqual(['iCloud', 'Work']);
    expect(accounts[1]?.addresses).toEqual(['me@work.com', 'alias@work.com']);
  });

  it('cleans up the narrow space Mail puts before AM/PM', async () => {
    darwin();
    const output = row('a', 'x@y.com', `Sunday, September 20, 2026 at 6:54:17${String.fromCharCode(0x202f)}PM`, 'false');
    const result = await new MailReadTool(() => on, async () => output).execute(input(), context() as never);
    expect((result.data as InboxData).items[0]?.receivedAt).toBe('Sunday, September 20, 2026 at 6:54:17 PM');
  });

  it('returns what it managed to read instead of failing outright', async () => {
    darwin();
    // Regression: "Summarize today's Hotmail emails" died with
    // "Command failed: /usr/bin/osascript ..." because a 58,000-message
    // mailbox cannot serve 50 messages with previews inside any timeout.
    const output = 'truncated' + RECORD + row('a', 'x@y.com', 'today', 'false');
    const result = await new MailReadTool(() => on, async () => output).execute(
      input({ maxMessages: 50, includePreview: true }),
      context() as never,
    );

    expect(result.ok).toBe(true);
    expect((result.data as InboxData).items).toHaveLength(1);
    expect(result.summary).toMatch(/still working after \d+s/);
    expect(result.summary).toMatch(/not everything/);
  });

  it('does not claim truncation when the read completed', async () => {
    darwin();
    const output = 'complete' + RECORD + row('a', 'x@y.com', 'today', 'false');
    const result = await new MailReadTool(() => on, async () => output).execute(
      input(),
      context() as never,
    );
    expect(result.summary).not.toMatch(/still working/);
  });

  it('caps previews well below the message cap, because bodies are the slow part', async () => {
    darwin();
    const run = vi.fn(async () => 'complete' + RECORD);
    await new MailReadTool(() => on, run).execute(
      input({ maxMessages: 50, includePreview: true }),
      context() as never,
    );

    const args = run.mock.calls[0]?.[1] as string[];
    expect(Number(args[2])).toBeLessThan(50);
    // ...and no cap is applied when previews are off.
    const run2 = vi.fn(async () => 'complete' + RECORD);
    await new MailReadTool(() => on, run2).execute(
      input({ maxMessages: 50, includePreview: false }),
      context() as never,
    );
    expect((run2.mock.calls[0]?.[1] as string[])[2]).toBe('50');
  });

  it('gives the script its own deadline, and the process a later one', async () => {
    darwin();
    const run = vi.fn(async () => 'complete' + RECORD);
    await new MailReadTool(() => on, run).execute(input({ maxSeconds: 30 }), context() as never);

    const [, args, timeoutMs] = run.mock.calls[0] as [string, string[], number];
    expect(args[5]).toBe('30'); // the script stops itself here...
    expect(timeoutMs).toBeGreaterThan(30_000); // ...before the process is killed
  });

  it('explains a killed process instead of echoing the command line', async () => {
    darwin();
    const tool = new MailReadTool(() => on, async () => {
      throw new Error('osascript-killed:70');
    });
    const result = await tool.execute(input(), context() as never);

    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/still working after 70s/);
    expect(result.error).toMatch(/fewer messages|shorter time window|previews off/);
    expect(result.error).not.toMatch(/usr\/bin\/osascript/);
  });

  it('stops for a human when macOS blocks automation', async () => {
    darwin();
    const tool = new MailReadTool(() => on, async () => {
      throw new Error('execution error: Not authorized to send Apple events to Mail. (-1743)');
    });
    const result = await tool.execute(input(), context() as never);
    expect(result.needsHuman?.reason).toMatch(/Privacy & Security/);
  });

  it('says so when Mail has no account', async () => {
    darwin();
    const tool = new MailReadTool(() => on, async () => {
      throw new Error('script error: no-account');
    });
    const result = await tool.execute(input(), context() as never);
    expect(result.summary).toMatch(/no account set up/i);
  });
});
