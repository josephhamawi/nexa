import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { MailConfig } from '../config/schema';
import { childLogger } from '../logging/logger';
import {
  APPLE_EVENT_TIMEOUT_SECONDS,
  deadlineFor,
  explainAppleScriptError,
  requireMac,
  runOsascript,
  splitOnce,
  type ScriptRunner,
} from './applescript';

const log = childLogger('tool:mail_read');

/**
 * Field and record separators.
 *
 * ASCII unit and record separators, because no subject line or sender name
 * contains them. Splitting on a comma or a tab would corrupt the moment
 * someone sent mail with one in the subject.
 */
const UNIT = String.fromCharCode(31);
const RECORD = String.fromCharCode(30);

const InputSchema = z.object({
  operation: z.enum(['read', 'list_accounts']).default('read'),
  /**
   * Which account to read. Accepts the account's name as Mail shows it
   * ("iCloud") or one of its addresses ("you@outlook.com"). Empty reads every
   * account, newest first within each.
   */
  account: z.string().trim().max(200).default(''),
  /** Only messages that arrived within this many hours. 24 is "today". */
  sinceHours: z.number().int().min(1).max(720).default(24),
  /** Skip anything already read. */
  unreadOnly: z.boolean().default(true),
  maxMessages: z.number().int().min(1).max(50).default(20),
  /**
   * How long Mail may spend on this, in seconds.
   *
   * Reading is far slower than it looks -- a large Exchange inbox costs seconds
   * per message -- so the script stops itself at this point and returns what it
   * has rather than being killed with nothing to show.
   */
  maxSeconds: z.number().int().min(10).max(240).default(60),
  /**
   * Include the opening of each message. Off by default: it costs an extra
   * Apple event per message and pulls far more of the user's private mail into
   * the model's context than a subject line does.
   */
  includePreview: z.boolean().default(false),
});

/**
 * Previews cost an extra Apple event each, and the body can be megabytes.
 *
 * On the mailbox this was built against, asking for 50 messages with previews
 * ran past every timeout and returned nothing at all. Fewer messages with
 * previews beats none.
 */
const PREVIEW_MESSAGE_CAP = 15;

type Input = z.infer<typeof InputSchema>;

export interface MailMessage {
  subject: string;
  sender: string;
  receivedAt: string;
  read: boolean;
  /** Which account it landed in, so a result from four inboxes stays legible. */
  account: string;
  preview?: string;
}

export interface MailAccount {
  name: string;
  addresses: string[];
  enabled: boolean;
}

/**
 * Reads the inbox of the macOS Mail app.
 *
 * Split from MailTool rather than added to it, for two reasons. It is not
 * mutating, so "check my mail" does not raise an approval prompt the way
 * sending does. And it carries its own permission, so a task granted the right
 * to draft a reply is not thereby granted the right to read everything.
 */
export class MailReadTool implements Tool<Input> {
  readonly name = 'mail_read';
  readonly description =
    'Read recent messages from the macOS Mail app, or list the configured accounts. ' +
    'Input: {operation: "read"|"list_accounts", account, sinceHours, unreadOnly, maxMessages, includePreview}. ' +
    'Returns subject, sender, time, read state and account for each message. Use it for "check my mail", ' +
    '"anything new today", or before summarising what has arrived. ' +
    'When the user names an account ("my outlook", "work mail"), pass it as `account`; leave it empty to read all of them.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.MAIL_READ];
  readonly mutating = false;

  constructor(
    private readonly config: () => MailConfig,
    private readonly run: ScriptRunner = runOsascript,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    if (!this.config().enabled) {
      return {
        ok: false,
        summary: 'Mail access is off',
        error: 'Turn on mail under Settings before asking Nexa to read your inbox.',
      };
    }

    const notMac = requireMac('Reading mail');
    if (notMac) return notMac;

    try {
      if (input.operation === 'list_accounts') return await this.listAccounts(context);

      const wanted = input.includePreview
        ? Math.min(input.maxMessages, PREVIEW_MESSAGE_CAP)
        : input.maxMessages;
      const { scriptSeconds, processMs } = deadlineFor(input.maxSeconds);

      const output = await this.run(READ_SCRIPT, [
        String(input.sinceHours),
        input.unreadOnly ? 'unread' : 'all',
        String(wanted),
        input.includePreview ? 'preview' : 'no-preview',
        input.account || this.config().defaultAccount || '',
        String(scriptSeconds),
      ], processMs);

      const { messages, truncated } = parseRead(output);
      const scope = input.unreadOnly ? 'unread ' : '';
      const window = input.sinceHours === 24 ? 'today' : `in the last ${input.sinceHours}h`;
      const asked = input.account || this.config().defaultAccount;
      const where = asked ? ` in ${asked}` : '';

      // An account filter that matched nothing is not the same as an empty
      // inbox, and saying "no mail" would send the user looking for lost email.
      if (messages.length === 0 && asked) {
        const known = await this.accountNames();
        if (known.length > 0 && !known.some((name) => name.toLowerCase() === asked.toLowerCase())) {
          return {
            ok: false,
            summary: `There is no mail account called "${asked}"`,
            error: `Mail has these accounts: ${known.join(', ')}. Use one of those, or leave the account empty to read all of them.`,
          };
        }
      }

      context.report(`${messages.length} ${scope}message(s) ${window}${where}`);
      context.addEvidence({
        kind: 'data',
        title: `Inbox: ${messages.length} message(s)`,
        summary: messages.map((message) => `${message.sender}: ${message.subject}`).join(' | ').slice(0, 200),
      });
      log.info({ count: messages.length, unreadOnly: input.unreadOnly }, 'inbox read');

      // Truncation is reported, never hidden: a summary built from the newest
      // 12 of 50 messages is useful, but only if the reader knows that is what
      // it is.
      // An empty read is usually true, but not always: Mail syncs on its own
      // schedule, so a message delivered two minutes ago may not be in the
      // local store yet. Say which it is rather than asserting an empty inbox.
      const base =
        messages.length === 0
          ? `No ${scope}mail ${window}${where}. (Nexa reads Mail's local copy, so anything not yet synced will not appear.)`
          : `${messages.length} ${scope}message(s) ${window}${where}`;

      return {
        ok: true,
        summary: truncated
          ? `${base} (Mail was still working after ${scriptSeconds}s, so this is the newest it could read, not everything.)`
          : base,
        data: {
          items: messages,
          count: messages.length,
          account: asked || 'all accounts',
          truncated,
        },
      };
    } catch (err) {
      const message = (err as Error).message;

      const shared = explainAppleScriptError(message, 'Mail');
      if (shared) return shared;

      if (/no-account/i.test(message)) {
        return {
          ok: false,
          summary: 'Mail has no account set up',
          error: 'The macOS Mail app has no account configured, so there is no inbox to read.',
        };
      }

      log.warn({ err: message }, 'inbox read failed');
      return { ok: false, summary: 'The inbox could not be read', error: message.slice(0, 500) };
    }
  }

  private async listAccounts(context: ToolContext): Promise<ToolResult> {
    const accounts = parseAccounts(await this.run(ACCOUNTS_SCRIPT, []));

    context.report(`${accounts.length} mail account(s)`);
    return {
      ok: true,
      summary:
        accounts.length === 0
          ? 'Mail has no accounts set up'
          : `Mail accounts: ${accounts.map((account) => describeAccount(account)).join(', ')}`,
      data: { accounts },
    };
  }

  /** Account names, for turning a bad filter into a useful error. */
  private async accountNames(): Promise<string[]> {
    try {
      return parseAccounts(await this.run(ACCOUNTS_SCRIPT, [])).flatMap((account) => [
        account.name,
        ...account.addresses,
      ]);
    } catch {
      return [];
    }
  }
}

/** "iCloud (you@icloud.com)", or just the name when it has no address. */
export function describeAccount(account: MailAccount): string {
  return account.addresses.length > 0 ? `${account.name} (${account.addresses.join(', ')})` : account.name;
}

export function parseAccounts(output: string): MailAccount[] {
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [name = '', addresses = '', enabled = ''] = record.split(UNIT);
      return {
        name: name.trim(),
        addresses: addresses.split(',').map((address) => address.trim()).filter(Boolean),
        enabled: enabled.trim() !== 'false',
      };
    });
}

/**
 * Splits the script's output into its header and its message records.
 *
 * The header says whether the script stopped early, which the caller has to
 * pass on -- a summary of the newest 12 of 50 messages is useful, but only if
 * the reader knows that is what they are looking at.
 */
export function parseRead(output: string): { messages: MailMessage[]; truncated: boolean } {
  const [header = '', rest = ''] = splitOnce(output, RECORD);
  const status = header.trim();

  // Older output had no header. Treat it as a complete read of everything.
  if (status !== 'complete' && status !== 'truncated') {
    return { messages: parseMessages(output), truncated: false };
  }

  return { messages: parseMessages(rest), truncated: status === 'truncated' };
}

/** Turns the script's separator-delimited output into records. */
export function parseMessages(output: string): MailMessage[] {
  return output
    .split(RECORD)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [subject = '', sender = '', receivedAt = '', read = '', account = '', preview = ''] =
        record.split(UNIT);
      const message: MailMessage = {
        subject: subject.trim() || '(no subject)',
        sender: sender.trim(),
        // Mail formats dates with a narrow no-break space before AM/PM, which
        // looks like corruption everywhere it is later displayed.
        receivedAt: receivedAt.trim().replace(/\u202f/g, ' '),
        read: read.trim() === 'true',
        account: account.trim(),
      };
      if (preview.trim()) message.preview = preview.trim().replace(/\s+/g, ' ').slice(0, 200);
      return message;
    });
}

const READ_SCRIPT = `
on run argv
	set sinceHours to (item 1 of argv) as integer
	set mode to item 2 of argv
	set maxMessages to (item 3 of argv) as integer
	set previewMode to item 4 of argv
	set wantedAccount to item 5 of argv
	set maxSeconds to (item 6 of argv) as integer

	set startedAt to (current date)
	set cutoff to startedAt - (sinceHours * 3600)
	set fieldSep to (ASCII character 31)
	set recSep to (ASCII character 30)
	set ranOut to false

	with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Mail"
		if (count of accounts) is 0 then error "no-account"

		set out to ""
		set found to 0

		repeat with acct in accounts
			if found < maxMessages and ranOut is false then
				set acctName to (name of acct as string)
				set matches to true
				if wantedAccount is not "" then
					set matches to (acctName is wantedAccount)
					if not matches then
						try
							repeat with addr in (email addresses of acct)
								if (addr as string) is wantedAccount then set matches to true
							end repeat
						end try
					end if
				end if

				if matches then
					-- Account inboxes are called INBOX on iCloud and IMAP, Inbox on
					-- Exchange. A case-sensitive lookup silently found neither.
					set box to missing value
					repeat with mb in mailboxes of acct
						set mbName to (name of mb as string)
						if mbName is "INBOX" or mbName is "Inbox" then
							set box to mb
							exit repeat
						end if
					end repeat

					if box is not missing value then
						-- Deliberately no "count of messages of box": counting a
						-- 58,000-message mailbox cost 19 seconds on its own. Walk
						-- from the newest and let the index run off the end.
						repeat with i from 1 to 500
							if found is greater than or equal to maxMessages then exit repeat

							-- The script's own deadline. "with timeout" bounds one
							-- Apple event, so a long loop of quick events sails past
							-- it and the process gets killed with nothing to show;
							-- stopping here returns the newest messages instead.
							if ((current date) - startedAt) is greater than maxSeconds then
								set ranOut to true
								exit repeat
							end if

							try
								set m to message i of box
							on error
								exit repeat
							end try

							set gotDate to date received of m

							-- Measured on this mailbox: a single account's inbox is
							-- strictly newest first, so the first message outside the
							-- window means every later index is older too. (The
							-- unified inbox is NOT ordered this way -- see the header
							-- comment on why this walks per account.)
							if gotDate is less than cutoff then exit repeat

							set isRead to read status of m
							if mode is not "unread" or isRead is false then
								set previewText to ""
								if previewMode is "preview" then
									try
										-- "text 1 thru 200" is an error, not a
										-- truncation, when the body is shorter than
										-- that -- which silently emptied the preview
										-- on every short message.
										set body to (content of m) as string
										if (length of body) > 200 then
											set previewText to text 1 thru 200 of body
										else
											set previewText to body
										end if
									on error
										set previewText to ""
									end try
								end if

								set out to out & (subject of m) & fieldSep & (sender of m) & fieldSep & (gotDate as string) & fieldSep & (isRead as string) & fieldSep & acctName & fieldSep & previewText & recSep
								set found to found + 1
							end if
						end repeat
					end if
				end if
			end if
		end repeat

		-- Header first so the caller always knows whether this is everything.
		if ranOut then
			return "truncated" & recSep & out
		else
			return "complete" & recSep & out
		end if
	end tell
	end timeout
end run
`;

const ACCOUNTS_SCRIPT = `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Mail"
		set fieldSep to (ASCII character 31)
		set recSep to (ASCII character 30)
		set out to ""
		repeat with acct in accounts
			set addrs to ""
			try
				repeat with addr in (email addresses of acct)
					if addrs is not "" then set addrs to addrs & ", "
					set addrs to addrs & (addr as string)
				end repeat
			end try
			set out to out & (name of acct as string) & fieldSep & addrs & fieldSep & (enabled of acct as string) & recSep
		end repeat
		return out
	end tell
end timeout
`;
