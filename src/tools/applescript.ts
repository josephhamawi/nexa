import { execFile } from 'node:child_process';
import type { ToolResult } from './Tool';

/**
 * `with timeout` bounds ONE Apple event, not the whole script.
 *
 * This caught us out: a loop of hundreds of individually-fast events runs for
 * minutes without ever tripping the 45s AppleEvent timeout, so the process kill
 * below fires instead and the user gets "Command failed: /usr/bin/osascript".
 * The script's own timeout only helps when a single event hangs.
 *
 * So scripts that loop take a soft deadline as an argument and stop themselves
 * (see `deadlineFor`), and the process timeout is only a backstop for a script
 * that has stopped responding entirely.
 */
export const APPLE_EVENT_TIMEOUT_SECONDS = 45;
export const OSASCRIPT_TIMEOUT_MS = 70_000;

/**
 * How long a looping script may run, and how long to let the process live.
 *
 * The gap between them is what makes partial results possible: the script
 * notices its own deadline, returns what it has, and the process exits
 * normally well before the kill.
 */
export function deadlineFor(seconds: number): { scriptSeconds: number; processMs: number } {
  const scriptSeconds = Math.max(10, Math.min(seconds, 240));
  return { scriptSeconds, processMs: (scriptSeconds + 20) * 1000 };
}

/** Signature the tools inject, so tests never need the real app. */
export type ScriptRunner = (script: string, args: string[], timeoutMs?: number) => Promise<string>;

/**
 * Runs an AppleScript, passing every value as `argv`.
 *
 * The script text is fixed and arrives on stdin; user and model data arrives
 * separately as process arguments. There is no string a title, a note body or
 * an email subject could contain that changes what the script does, because
 * nothing is ever concatenated into the source.
 */
export const runOsascript: ScriptRunner = (script, args, timeoutMs = OSASCRIPT_TIMEOUT_MS) =>
  new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-', ...args],
      { timeout: timeoutMs, maxBuffer: 8_388_608 },
      (err, stdout, stderr) => {
        if (err) {
          // A killed process has empty stderr, so err.message is the raw
          // command line -- which names the account, tells the user nothing,
          // and is what "Command failed: /usr/bin/osascript ..." came from.
          const killed = (err as { killed?: boolean }).killed === true;
          const signal = (err as { signal?: string }).signal;
          if (killed || signal === 'SIGTERM' || /ETIMEDOUT/.test(err.message)) {
            reject(new Error(`osascript-killed:${Math.round(timeoutMs / 1000)}`));
            return;
          }
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve(stdout);
      },
    ).stdin?.end(script);
  });

/**
 * Turns an osascript failure into something the model and the user can both
 * act on. A bare "execution error: -1743" tells neither of them anything.
 *
 * Returns null when the error is not one of the shared macOS ones, leaving the
 * caller to explain whatever is specific to its own app.
 */
export function explainAppleScriptError(message: string, appName: string): ToolResult | null {
  if (/-1743|not authori[sz]ed|not allowed assistive/i.test(message)) {
    return {
      ok: false,
      summary: `macOS has not granted Nexa access to ${appName}`,
      needsHuman: {
        reason:
          `macOS is blocking Nexa from controlling ${appName}. Open System Settings > Privacy & Security > ` +
          `Automation, allow Nexa to control ${appName}, then press Resume.`,
      },
    };
  }

  const killed = message.match(/^osascript-killed:(\d+)$/);
  if (killed) {
    return {
      ok: false,
      summary: `${appName} was still working after ${killed[1]}s`,
      error:
        `${appName} did not finish in ${killed[1]}s and was stopped. This usually means the request covered ` +
        'too much mail at once. Ask for fewer messages, a shorter time window, or leave previews off.',
    };
  }

  if (/-1712|appleevent timed out|timed out/i.test(message)) {
    // Seen on the very first call: the app is launching behind a macOS
    // permission prompt that nobody has answered yet, so the work never lands.
    // Telling the user to "try again" would leave them looping.
    return {
      ok: false,
      summary: `${appName} did not answer in time`,
      needsHuman: {
        reason:
          `${appName} did not respond within ${APPLE_EVENT_TIMEOUT_SECONDS}s. Open ${appName} once and answer any ` +
          'macOS permission prompt asking to let Nexa control it, then press Resume. If it is mid-sync, ' +
          'waiting for that to finish and resuming also works.',
      },
    };
  }

  return null;
}

/** Pulls the name out of a `no-calendar:Work` style error raised by a script. */
export function missingTarget(message: string, marker: string): string | null {
  const found = message.match(new RegExp(`${marker}:(.*)$`, 'm'));
  return found?.[1]?.trim() ?? null;
}

/** macOS-only guard, shared by every AppleScript-backed tool. */
export function requireMac(what: string): ToolResult | null {
  if (process.platform === 'darwin') return null;
  return {
    ok: false,
    summary: `${what} is macOS only`,
    error: `Nexa can only do that on macOS; this machine reports "${process.platform}".`,
  };
}

/** Splits `created:ABC-123` into its outcome and its payload. */
export function splitOnce(value: string, separator: string): [string, string?] {
  const index = value.indexOf(separator);
  if (index === -1) return [value];
  return [value.slice(0, index), value.slice(index + separator.length)];
}
