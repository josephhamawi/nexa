/**
 * Installs or removes a macOS LaunchAgent that keeps Nexa running.
 *
 *   node scripts/autostart.mjs install
 *   node scripts/autostart.mjs status
 *   node scripts/autostart.mjs remove
 *
 * The Settings toggle uses macOS login items, which start Nexa when you log in.
 * This goes one step further: `KeepAlive` restarts it if it crashes or is
 * killed, which is what a scheduler actually needs. Use whichever you prefer;
 * running both is harmless but pointless.
 */
import { writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

const LABEL = 'com.nexa.agent';
const root = path.resolve(import.meta.dirname, '..');
const agentDir = path.join(homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(agentDir, `${LABEL}.plist`);

/** Prefers the packaged app; falls back to the built dev entry point. */
function resolveTarget() {
  const packaged = path.join(root, 'release', 'mac', 'Nexa.app', 'Contents', 'MacOS', 'Nexa');
  if (existsSync(packaged)) return { command: packaged, args: [], kind: 'packaged app' };

  const installed = '/Applications/Nexa.app/Contents/MacOS/Nexa';
  if (existsSync(installed)) return { command: installed, args: [], kind: 'installed app' };

  const electron = path.join(root, 'node_modules', '.bin', 'electron');
  const main = path.join(root, 'dist', 'main', 'main.js');
  if (existsSync(electron) && existsSync(main)) {
    return { command: electron, args: [main], kind: 'development build' };
  }

  return null;
}

function buildPlist(target) {
  const programArgs = [target.command, ...target.args]
    .map((value) => `    <string>${value}</string>`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>

  <!-- Start at login. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Restart if it crashes or is killed, which a scheduler depends on. -->
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <!-- Back off rather than spinning if it fails on startup. -->
  <key>ThrottleInterval</key>
  <integer>30</integer>

  <key>StandardOutPath</key>
  <string>${path.join(root, 'data', 'logs', 'launchagent.out.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(root, 'data', 'logs', 'launchagent.err.log')}</string>
</dict>
</plist>
`;
}

async function install() {
  const target = resolveTarget();
  if (!target) {
    console.error('Nothing to launch. Run "npm run build" first, or "npm run package" for the app.');
    process.exit(1);
  }

  await mkdir(agentDir, { recursive: true });
  await mkdir(path.join(root, 'data', 'logs'), { recursive: true });
  await writeFile(plistPath, buildPlist(target), 'utf8');

  // bootout first so a reinstall picks up the new plist rather than the old one.
  await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]).catch(() => undefined);
  await run('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]);

  console.log(`Installed: ${plistPath}`);
  console.log(`Launching: ${target.command} (${target.kind})`);
  console.log('Nexa will now start at login and restart if it stops.');
  console.log('Remove it with: npm run autostart:remove');
}

async function remove() {
  await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`]).catch(() => undefined);
  if (existsSync(plistPath)) await rm(plistPath);
  console.log('Removed. Nexa will no longer start automatically.');
}

async function status() {
  const installed = existsSync(plistPath);
  console.log(`plist      ${installed ? plistPath : 'not installed'}`);

  if (!installed) return;

  const { stdout } = await run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]).catch(() => ({
    stdout: '',
  }));
  const state = stdout.match(/state = (\w+)/)?.[1] ?? 'unknown';
  const pid = stdout.match(/pid = (\d+)/)?.[1];
  console.log(`state      ${state}${pid ? ` (pid ${pid})` : ''}`);
}

const command = process.argv[2] ?? 'status';

if (process.platform !== 'darwin') {
  console.error('This script is macOS only. On Linux use a systemd user unit; on Windows, Task Scheduler.');
  process.exit(1);
}

const actions = { install, remove, status };
const action = actions[command];

if (!action) {
  console.error(`Unknown command "${command}". Use install, remove or status.`);
  process.exit(1);
}

await action();
