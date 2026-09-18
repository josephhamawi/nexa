import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { childLogger } from '../logging/logger';
import { sleep } from '../utils/time';

const log = childLogger('sound');

const BELL = '\u0007';

const MAC_SOUND_CANDIDATES = [
  '/System/Library/Sounds/Submarine.aiff',
  '/System/Library/Sounds/Sosumi.aiff',
  '/System/Library/Sounds/Glass.aiff',
];

const LINUX_SOUND_CANDIDATES = [
  '/usr/share/sounds/freedesktop/stereo/complete.oga',
  '/usr/share/sounds/freedesktop/stereo/bell.oga',
];

/** Plays an attention-grabbing alert. Can be disabled in config.json. */
export class SoundNotifier {
  constructor(private readonly enabled: boolean) {}

  isReady(): boolean {
    return this.enabled;
  }

  /** Repeats the tone a few times so it is hard to miss from another room. */
  async alert(repeats = 3): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      for (let i = 0; i < repeats; i += 1) {
        await this.playOnce();
        if (i < repeats - 1) await sleep(700);
      }
      return true;
    } catch (err) {
      log.debug({ err: (err as Error).message }, 'sound playback failed');
      return false;
    }
  }

  private async playOnce(): Promise<void> {
    if (process.platform === 'darwin') {
      const file = MAC_SOUND_CANDIDATES.find((f) => fs.existsSync(f));
      if (file) return run('afplay', [file]);
      return run('osascript', ['-e', 'beep 1']);
    }

    if (process.platform === 'linux') {
      const file = LINUX_SOUND_CANDIDATES.find((f) => fs.existsSync(f));
      if (file) {
        return run('paplay', [file]).catch(() => run('aplay', [file]));
      }
      process.stdout.write(BELL);
      return;
    }

    if (process.platform === 'win32') {
      return run('powershell', ['-NoProfile', '-Command', '[console]::beep(880,400)']);
    }

    process.stdout.write(BELL);
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
