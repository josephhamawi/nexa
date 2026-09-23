import fs from 'node:fs';
import path from 'node:path';

/**
 * Secrets at rest, encrypted by the OS keychain when one is available.
 *
 * Nexa holds an API key and a bot token that can spend money and read mail,
 * and they lived in a plaintext .env. Owner-only permissions stop another
 * user; they do not stop anything running as you, which on a machine that
 * runs downloaded software is the case that matters.
 *
 * Electron's safeStorage encrypts with a key held in the login keychain, so
 * the file on disk is ciphertext. It is deliberately not a hard dependency:
 * the CLI entry points (doctor, agent) run outside Electron, so this falls
 * back to the plaintext file rather than refusing to start. Reading supports
 * both, which is also what makes the migration from an existing .env work.
 */
export interface SecretStore {
  read(): Record<string, string>;
  write(values: Record<string, string>): void;
  /** True when values are encrypted at rest rather than readable on disk. */
  readonly encrypted: boolean;
}

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/**
 * Electron's safeStorage, when running inside Electron and it is usable.
 *
 * Loaded through a runtime require so the CLI tools, which never have
 * Electron, do not fail to import this module at all.
 */
function safeStorage(): SafeStorage | null {
  try {
     
    const electron = require('electron') as { safeStorage?: SafeStorage; app?: { isReady(): boolean } };
    const storage = electron.safeStorage;
    if (!storage || !electron.app?.isReady()) return null;
    return storage.isEncryptionAvailable() ? storage : null;
  } catch {
    return null;
  }
}

const ENCRYPTED_SUFFIX = '.enc';

export function createSecretStore(envFile: string): SecretStore {
  const encryptedFile = `${envFile}${ENCRYPTED_SUFFIX}`;
  const storage = safeStorage();

  const readPlain = (): Record<string, string> =>
    fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, 'utf8')) : {};

  const readEncrypted = (): Record<string, string> | null => {
    if (!storage || !fs.existsSync(encryptedFile)) return null;
    try {
      return parseEnv(storage.decryptString(fs.readFileSync(encryptedFile)));
    } catch {
      // A keychain the user declined, or a file from another machine. Falling
      // back beats refusing to start with no way to re-enter the secret.
      return null;
    }
  };

  return {
    encrypted: Boolean(storage),

    read(): Record<string, string> {
      // Plaintext still wins when present, so an existing .env keeps working
      // and a user can always drop a key in by hand.
      const plain = readPlain();
      return Object.keys(plain).length > 0 ? plain : (readEncrypted() ?? {});
    },

    write(values: Record<string, string>): void {
      const merged = { ...this.read(), ...values };
      const body = `${Object.entries(merged)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n')}\n`;

      if (!storage) {
        fs.mkdirSync(path.dirname(envFile), { recursive: true });
        fs.writeFileSync(envFile, body, { encoding: 'utf8', mode: 0o600 });
        return;
      }

      fs.mkdirSync(path.dirname(encryptedFile), { recursive: true });
      fs.writeFileSync(encryptedFile, storage.encryptString(body), { mode: 0o600 });

      // The whole point is that the readable copy stops existing.
      if (fs.existsSync(envFile)) fs.rmSync(envFile);
    },
  };
}

/** Minimal KEY=value parsing; comments and blank lines are skipped. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
    if (value) out[match[1] as string] = value;
  }
  return out;
}
