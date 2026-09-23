import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { Permission } from '../tasks/Task';
import type { Tool, ToolContext, ToolResult } from './Tool';
import type { ShellConfig } from '../config/schema';
import { childLogger } from '../logging/logger';

const log = childLogger('tool:shell');

const InputSchema = z.object({
  /** The program to run. Must be on the allow-list, by name, not by path. */
  command: z.string().trim().min(1).max(200),
  /**
   * Arguments, already separated. Not a command line: nothing here is parsed
   * by a shell, so an argument containing a space or a quote is just that.
   */
  args: z.array(z.string()).max(50).default([]),
  /** Why this is being run, shown in the approval prompt. */
  reason: z.string().trim().max(300).default(''),
});

type Input = z.infer<typeof InputSchema>;

/**
 * Characters that only mean something to a shell.
 *
 * Nothing here is executed by a shell, so these cannot chain a second command
 * -- but their presence means the model is trying to write a command line
 * rather than call a program, and the honest response is to say so rather
 * than run half of what was intended.
 */
const SHELL_METACHARACTERS = /[;&|`$(){}<>\n\r\\]/;

/**
 * Runs a program, from a list you wrote.
 *
 * The threat this is built against is not a careless user, it is the mail and
 * the web pages Nexa reads. Those are written by other people, and an agent
 * that will run whatever text it is handed turns a malicious email into
 * command execution. Three things stand in the way:
 *
 * - An allow-list of programs. Empty by default, so nothing runs until a
 *   human names something. A deny-list would be the wrong shape: you cannot
 *   enumerate every dangerous program, but you can enumerate the few useful
 *   ones.
 * - No shell. `execFile` takes a program and an argument vector, so `rm -rf /`
 *   cannot be smuggled through an argument, and `&&` chains nothing.
 * - `mutating` is true, so every call passes the approval prompt.
 *
 * A task also cannot acquire EXECUTE part-way through: permissions are fixed
 * when the plan is made and every step is checked against them, so an
 * adaptive step added after reading a hostile page is refused.
 */
export class ShellTool implements Tool<Input> {
  readonly name = 'shell';
  readonly description =
    'Run one of the commands the user has explicitly allowed. ' +
    'Input: {command, args: [...], reason}. `command` is a program name such as "git" or "ls", and `args` are ' +
    'separate strings -- this is not a shell, so pipes, redirects and && do not work and will be refused. ' +
    'Use operation "list_allowed" style reasoning first if unsure: an unknown command is refused and the ' +
    'error names what is available.';
  readonly inputSchema = InputSchema;
  readonly permissions = [Permission.EXECUTE];
  readonly mutating = true;

  constructor(private readonly config: () => ShellConfig) {}

  async execute(input: Input, context: ToolContext): Promise<ToolResult> {
    const { enabled, allowedCommands, workingDirectory, timeoutSeconds } = this.config();

    if (!enabled) {
      return {
        ok: false,
        summary: 'Running commands is switched off',
        error: 'Turn on command running under Settings, and list the commands Nexa may use.',
      };
    }

    if (allowedCommands.length === 0) {
      return {
        ok: false,
        summary: 'No commands are allowed yet',
        error:
          'Command running is on but the allow-list is empty, so nothing can run. ' +
          'Add the specific commands you want under Settings.',
      };
    }

    // A path, rather than a bare name, is an attempt to reach outside the
    // list: "git" being allowed must not permit "/tmp/evil/git".
    if (input.command.includes('/')) {
      return {
        ok: false,
        summary: 'Commands are named, not paths',
        error: `Use a program name such as "git", not a path like "${input.command}".`,
      };
    }

    if (!allowedCommands.includes(input.command)) {
      return {
        ok: false,
        summary: `"${input.command}" is not on the allow-list`,
        error:
          `Nexa may run: ${allowedCommands.join(', ')}. ` +
          `Add "${input.command}" under Settings if you want it available.`,
      };
    }

    const suspicious = [input.command, ...input.args].find((part) => SHELL_METACHARACTERS.test(part));
    if (suspicious !== undefined) {
      return {
        ok: false,
        summary: 'That looks like a shell command, not a program call',
        error:
          `"${suspicious}" contains shell syntax. Nexa runs a program with arguments and never a shell, ` +
          'so pipes, redirects, substitutions and && have no effect. Pass the program and its arguments separately.',
      };
    }

    const cwd = workingDirectory || os.homedir();
    const started = Date.now();

    try {
      const { stdout, stderr, code } = await run(input.command, input.args, cwd, timeoutSeconds);
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').slice(0, 20_000);

      context.report(`${input.command} finished (${code === 0 ? 'ok' : `exit ${code}`})`);
      context.addEvidence({
        kind: 'data',
        title: `Ran ${input.command}`,
        summary: `${[input.command, ...input.args].join(' ').slice(0, 160)} -> exit ${code}`,
      });
      log.info({ command: input.command, code, ms: Date.now() - started }, 'command run');

      // A non-zero exit is a result, not a tool failure: the model should see
      // the output and decide, the way a person reading a terminal would.
      return {
        ok: true,
        summary:
          code === 0
            ? `${input.command} succeeded`
            : `${input.command} exited ${code}`,
        data: { command: input.command, args: input.args, exitCode: code, output },
      };
    } catch (err) {
      const message = (err as Error).message;

      if (/ENOENT/.test(message)) {
        return {
          ok: false,
          summary: `"${input.command}" is not installed`,
          error: `${input.command} is on the allow-list but was not found on this machine.`,
        };
      }

      if (/killed|ETIMEDOUT/i.test(message)) {
        return {
          ok: false,
          summary: `${input.command} did not finish in ${timeoutSeconds}s`,
          error: `${input.command} was still running after ${timeoutSeconds}s and was stopped.`,
        };
      }

      log.warn({ command: input.command, err: message }, 'command failed');
      return { ok: false, summary: `${input.command} could not be run`, error: message.slice(0, 400) };
    }
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutSeconds: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // No `shell: true`. That single option is the difference between running a
    // program and handing a string to bash.
    execFile(
      command,
      args,
      { cwd: path.resolve(cwd), timeout: timeoutSeconds * 1000, maxBuffer: 4_194_304 },
      (err, stdout, stderr) => {
        const code = (err as { code?: number } | null)?.code;
        if (err && typeof code !== 'number') {
          reject(err);
          return;
        }
        resolve({ stdout, stderr, code: code ?? 0 });
      },
    );
  });
}
