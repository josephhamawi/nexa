import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { MailConfig } from '../config/schema';
import { childLogger } from '../logging/logger';
import {
  APPLE_EVENT_TIMEOUT_SECONDS,
  explainAppleScriptError,
  requireMac,
  runOsascript,
  splitOnce,
  type ScriptRunner,
} from './applescript';

const log = childLogger('tool:mail');

const InputSchema = z.object({
  /**
   * "draft" leaves the message in Mail's Drafts for the user to send.
   * "send" delivers it, and only works if sending was switched on in config.
   */
  operation: z.enum(['draft', 'send']).default('draft'),
  to: z.array(z.string().trim()).min(1).max(20),
  subject: z.string().trim().min(1).max(300),
  body: z.string().max(100_000).default(''),
});

type Input = z.infer<typeof InputSchema>;

/**
 * Composes mail through the macOS Mail app.
 *
 * Whatever accounts Mail already has set up are the accounts this reaches, so
 * a Gmail or Outlook address configured there works without Nexa ever holding
 * an OAuth token of its own.
 *
 * Drafting is the default and sending is opt-in twice over: `allowSend` has to
 * be true in config, and the step still passes the approval gate like every
 * other mutating tool. Sending mail as someone is the most consequential thing
 * Nexa can do, so it is the one capability that is not one setting away.
 */
export class MailTool implements Tool<Input> {
  readonly name = 'mail';
  readonly description =
    'Compose an email in the macOS Mail app. Input: {operation: "draft"|"send", to: [addresses], subject, body}. ' +
    '"draft" saves it to Drafts for the user to review and send, and is the right choice unless they asked for it ' +
    'to go out. "send" delivers it immediately and is often switched off.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.MAIL];
  readonly mutating = true;

  constructor(
    private readonly config: () => MailConfig,
    private readonly run: ScriptRunner = runOsascript,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const { enabled, allowSend } = this.config();

    if (!enabled) {
      return {
        ok: false,
        summary: 'Mail access is off',
        error: 'Turn on mail under Settings before asking Nexa to write email.',
      };
    }

    const notMac = requireMac('Composing mail');
    if (notMac) return notMac;

    if (input.operation === 'send' && !allowSend) {
      // Quietly drafting instead would be worse: the user would believe their
      // mail went out. Refuse, and say exactly which setting changes it.
      return {
        ok: false,
        summary: 'Nexa is not allowed to send mail',
        error:
          'Sending is switched off. Nexa can leave this in Drafts instead, or you can turn on ' +
          '"Let Nexa send mail, not just draft it" under Settings.',
      };
    }

    const bad = input.to.filter((address) => !isEmailAddress(address));
    if (bad.length > 0) {
      return {
        ok: false,
        summary: 'Those recipients are not email addresses',
        error: `Not valid email addresses: ${bad.join(', ')}. Each recipient must look like name@example.com.`,
      };
    }

    try {
      const output = await this.run(COMPOSE_SCRIPT, [
        input.subject,
        input.body,
        input.to.join(','),
        input.operation,
      ]);

      const [outcome] = splitOnce(output.trim(), ':');
      const sent = outcome === 'sent';
      const recipients = input.to.join(', ');

      context.report(sent ? `Sent to ${recipients}` : `Drafted to ${recipients}`);
      context.addEvidence({
        kind: 'note',
        title: `Mail ${sent ? 'sent' : 'drafted'}: ${input.subject}`,
        summary: `To ${recipients}. ${input.body.slice(0, 200).replace(/\s+/g, ' ')}`,
      });
      log.info({ sent, recipients: input.to.length }, 'mail composed');

      return {
        ok: true,
        summary: sent
          ? `Sent "${input.subject}" to ${recipients}`
          : `Left "${input.subject}" in Drafts for ${recipients}. Open Mail to review and send it.`,
        data: { sent, to: input.to, subject: input.subject },
      };
    } catch (err) {
      const message = (err as Error).message;

      const shared = explainAppleScriptError(message, 'Mail');
      if (shared) return shared;

      if (/no-account|no mail account/i.test(message)) {
        return {
          ok: false,
          summary: 'Mail has no account set up',
          error: 'The macOS Mail app has no account configured, so there is nothing to send from.',
        };
      }

      log.warn({ err: message, operation: input.operation }, 'mail operation failed');
      return { ok: false, summary: 'The mail could not be composed', error: message.slice(0, 500) };
    }
  }
}

/**
 * Deliberately strict rather than RFC-complete.
 *
 * A model that hallucinates "the hiring manager" as a recipient should get a
 * clear rejection, not a message addressed to a string Mail will silently drop.
 */
export function isEmailAddress(value: string): boolean {
  return /^[^\s@,<>]+@[^\s@,<>]+\.[a-z]{2,}$/i.test(value.trim());
}

const COMPOSE_SCRIPT = `
on run argv
	set subj to item 1 of argv
	set bodyText to item 2 of argv
	set toList to item 3 of argv
	set mode to item 4 of argv

	with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Mail"
		if (count of accounts) is 0 then error "no-account"

		set msg to make new outgoing message with properties {subject:subj, content:bodyText, visible:false}
		set AppleScript's text item delimiters to ","
		repeat with addr in (text items of toList)
			tell msg to make new to recipient at end of to recipients with properties {address:(addr as string)}
		end repeat
		set AppleScript's text item delimiters to ""

		if mode is "send" then
			send msg
			return "sent:" & subj
		else
			save msg
			return "drafted:" & subj
		end if
	end tell
	end timeout
end run
`;
