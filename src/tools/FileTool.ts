import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { FilesConfig } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('tool:files');

const InputSchema = z.object({
  operation: z.enum(['list', 'read', 'recent']).default('list'),
  /** Directory or file. Must sit inside an allowed directory. */
  target: z.string().default(''),
  /** recent only: how far back to look. */
  sinceHours: z.number().int().min(1).max(8760).default(24),
  maxFiles: z.number().int().min(1).max(50).default(10),
});

type Input = z.infer<typeof InputSchema>;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.log', '.html', '.htm', '.xml', '.ts', '.js', '.py', '.sh', '.rtf',
]);

export class PathNotAllowedError extends Error {
  constructor(target: string) {
    super(
      `"${target}" is outside the directories Nexa is allowed to read. ` +
        'Add it under Settings if you want Nexa to see it.',
    );
    this.name = 'PathNotAllowedError';
  }
}

/**
 * Reads files, but only inside directories you have explicitly allowed.
 *
 * The allow-list is the whole point. The agent can be asked to read anything,
 * and anything outside the list is refused before a single byte is opened, so
 * a badly worded instruction cannot wander into the rest of the disk.
 */
export class FileTool implements Tool<Input> {
  readonly name = 'files';
  readonly description =
    'List, read or find recent files inside the directories you have allowed. Input: {operation, target, sinceHours}.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.FILES];
  readonly mutating = false;

  constructor(private readonly config: () => FilesConfig) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const { allowedDirectories, maxFileSizeMb } = this.config();

    if (allowedDirectories.length === 0) {
      return {
        ok: false,
        summary: 'No folders are allowed yet',
        error: 'Add an allowed folder under Settings before using file tasks.',
      };
    }

    const roots = allowedDirectories.map((dir) => path.resolve(dir));
    const target = input.target ? path.resolve(input.target) : (roots[0] as string);

    if (!isInside(target, roots)) {
      return { ok: false, summary: 'That path is not allowed', error: new PathNotAllowedError(input.target).message };
    }

    try {
      switch (input.operation) {
        case 'list':
          return this.list(target, input.maxFiles, context);
        case 'recent':
          return this.recent(target, input.sinceHours, input.maxFiles, context);
        case 'read':
          return this.read(target, maxFileSizeMb, context);
        default:
          return { ok: false, summary: 'Unknown file operation', error: 'bad operation' };
      }
    } catch (err) {
      return { ok: false, summary: 'File operation failed', error: (err as Error).message };
    }
  }

  private list(dir: string, maxFiles: number, context: ToolContext): ToolResult {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .slice(0, maxFiles)
      .map((entry) => ({
        name: entry.name,
        path: path.join(dir, entry.name),
        kind: entry.isDirectory() ? 'directory' : 'file',
      }));

    context.report(`Listed ${entries.length} entries`);
    return { ok: true, summary: `${entries.length} entries in ${path.basename(dir)}`, data: { items: entries } };
  }

  private recent(dir: string, sinceHours: number, maxFiles: number, context: ToolContext): ToolResult {
    const cutoff = Date.now() - sinceHours * 3_600_000;
    const found: { name: string; path: string; modified: string }[] = [];

    const walk = (current: string, depth: number): void => {
      if (depth > 3 || found.length >= maxFiles) return;
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= cutoff) {
          found.push({ name: entry.name, path: full, modified: new Date(stat.mtimeMs).toISOString() });
        }
        if (found.length >= maxFiles) return;
      }
    };

    walk(dir, 0);
    context.report(`${found.length} file(s) changed in the last ${sinceHours}h`);
    return {
      ok: true,
      summary: `${found.length} file(s) added or changed in the last ${sinceHours}h`,
      data: { items: found },
    };
  }

  private read(file: string, maxFileSizeMb: number, context: ToolContext): ToolResult {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return { ok: false, summary: 'That is a directory', error: 'expected a file' };

    if (stat.size > maxFileSizeMb * 1_048_576) {
      return {
        ok: false,
        summary: 'File is too large to read',
        error: `${(stat.size / 1_048_576).toFixed(1)} MB exceeds the ${maxFileSizeMb} MB limit`,
      };
    }

    const extension = path.extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      // Binary formats (PDF, DOCX) need a converter Nexa does not ship yet.
      return {
        ok: false,
        summary: `Nexa cannot read ${extension || 'this file type'} yet`,
        error: `unsupported extension "${extension}"; text formats only for now`,
      };
    }

    const text = fs.readFileSync(file, 'utf8').slice(0, 200_000);
    context.report(`Read ${path.basename(file)}`);
    context.addEvidence({ kind: 'file', path: file, title: path.basename(file), summary: `${stat.size} bytes` });
    log.debug({ file: path.basename(file) }, 'file read');

    return { ok: true, summary: `Read ${path.basename(file)}`, data: { text, path: file } };
  }
}

function isInside(target: string, roots: string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(`${root}${path.sep}`));
}
