import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { NotesConfig } from '../config/schema';
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

const log = childLogger('tool:notes');

const InputSchema = z.object({
  operation: z.enum(['create', 'list_folders']).default('create'),
  /** create only. Becomes the note's title. */
  title: z.string().trim().min(1).max(200).default(''),
  /** create only. Plain text. Line breaks are kept. */
  body: z.string().max(100_000).default(''),
  /** Which Notes folder to write to. Empty uses the configured default. */
  folder: z.string().trim().max(120).default(''),
});

type Input = z.infer<typeof InputSchema>;

/**
 * Writes notes into the macOS Notes app.
 *
 * Built to the same shape as CalendarTool: mutating so the approval gate
 * covers it, every value passed as `argv` rather than spliced into the script,
 * and idempotent on the title so a retry does not leave two copies behind.
 */
export class NotesTool implements Tool<Input> {
  readonly name = 'notes';
  readonly description =
    'Save a note to the macOS Notes app, or list the available Notes folders. ' +
    'Input: {operation: "create"|"list_folders", title, body, folder}. ' +
    'Use it to keep a finding, a summary or a shortlist somewhere the user will find it later.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.NOTES];
  readonly mutating = true;

  constructor(
    private readonly config: () => NotesConfig,
    private readonly run: ScriptRunner = runOsascript,
  ) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const { enabled, defaultFolder } = this.config();

    if (!enabled) {
      return {
        ok: false,
        summary: 'Notes access is off',
        error: 'Turn on Notes access under Settings before asking Nexa to save notes.',
      };
    }

    const notMac = requireMac('Saving notes');
    if (notMac) return notMac;

    try {
      if (input.operation === 'list_folders') return await this.listFolders(context);
      return await this.create(input, defaultFolder, context);
    } catch (err) {
      return this.explain(err as Error, input);
    }
  }

  private async listFolders(context: ToolContext): Promise<ToolResult> {
    const output = await this.run(LIST_SCRIPT, []);
    const names = output.split('\n').map((line) => line.trim()).filter(Boolean);

    context.report(`Found ${names.length} Notes folder(s)`);
    return {
      ok: true,
      summary: names.length > 0 ? `Notes folders: ${names.join(', ')}` : 'No Notes folders found',
      data: { folders: names },
    };
  }

  private async create(input: Input, defaultFolder: string, context: ToolContext): Promise<ToolResult> {
    if (!input.title) {
      return { ok: false, summary: 'The note needs a title', error: 'title is required for operation "create"' };
    }

    const folder = input.folder || defaultFolder || 'Notes';
    const output = await this.run(CREATE_SCRIPT, [input.title, toHtml(input.title, input.body), folder]);
    const [outcome] = splitOnce(output.trim(), ':');
    const duplicate = outcome === 'duplicate';

    context.report(duplicate ? `Note already existed: ${input.title}` : `Saved "${input.title}"`);
    context.addEvidence({
      kind: 'note',
      title: `Note: ${input.title}`,
      summary: `${input.body.slice(0, 200).replace(/\s+/g, ' ')}${duplicate ? ' (already existed)' : ''}`,
    });
    log.info({ folder, duplicate }, 'note written');

    return {
      ok: true,
      summary: duplicate
        ? `"${input.title}" was already in ${folder}, so nothing was added`
        : `Saved "${input.title}" to ${folder}`,
      data: { title: input.title, folder, duplicate },
    };
  }

  private explain(err: Error, input: Input): ToolResult {
    const message = err.message;

    const shared = explainAppleScriptError(message, 'Notes');
    if (shared) return shared;

    const missing = missingTarget(message, 'no-folder');
    if (missing) {
      return {
        ok: false,
        summary: `There is no Notes folder called "${missing}"`,
        error: `Notes folder "${missing}" does not exist. Run operation "list_folders" to see the real names.`,
      };
    }

    log.warn({ err: message, operation: input.operation }, 'notes operation failed');
    return { ok: false, summary: 'The note could not be saved', error: message.slice(0, 500) };
  }
}

/**
 * Notes stores bodies as HTML and takes the title from the first line, so the
 * text has to be escaped and wrapped rather than handed over raw. A note body
 * containing `<script>` must read as those characters, not disappear into
 * markup.
 */
export function toHtml(title: string, body: string): string {
  const escape = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  const lines = body.split(/\r?\n/).map((line) => `<div>${escape(line) || '<br>'}</div>`);
  return `<div><h1>${escape(title)}</h1></div>${lines.join('')}`;
}

const LIST_SCRIPT = `
with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Notes"
		set out to ""
		repeat with f in folders
			set out to out & (name of f) & linefeed
		end repeat
		return out
	end tell
end timeout
`;

const CREATE_SCRIPT = `
on run argv
	set noteTitle to item 1 of argv
	set noteBody to item 2 of argv
	set folderName to item 3 of argv

	with timeout of ${APPLE_EVENT_TIMEOUT_SECONDS} seconds
	tell application "Notes"
		set theFolder to missing value
		repeat with f in folders
			if (name of f as string) is folderName then
				set theFolder to f
				exit repeat
			end if
		end repeat
		if theFolder is missing value then error "no-folder:" & folderName

		-- Idempotency: a retry after a timeout must not leave two copies.
		repeat with n in (notes of theFolder)
			if (name of n as string) is noteTitle then return "duplicate:" & noteTitle
		end repeat

		set newNote to make new note at theFolder with properties {name:noteTitle, body:noteBody}
		return "created:" & noteTitle
	end tell
	end timeout
end run
`;
