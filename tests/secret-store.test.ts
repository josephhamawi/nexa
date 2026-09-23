import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecretStore, parseEnv } from '../src/config/secretStore';
import { JsonStore } from '../src/storage/JsonStore';

const dirs: string[] = [];
function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-secrets-'));
  dirs.push(dir);
  return path.join(dir, '.env');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(path.dirname(path.join(dir, 'x')), { recursive: true, force: true });
});

describe('secret store', () => {
  it('falls back to a plaintext file outside Electron rather than refusing to run', () => {
    // doctor and the agent CLI have no Electron, so safeStorage is absent.
    const file = scratch();
    const store = createSecretStore(file);
    expect(store.encrypted).toBe(false);

    store.write({ ANTHROPIC_API_KEY: 'sk-test-123' });
    expect(store.read().ANTHROPIC_API_KEY).toBe('sk-test-123');
  });

  it('keeps owner-only permissions on the fallback file', () => {
    const file = scratch();
    createSecretStore(file).write({ TELEGRAM_BOT_TOKEN: 'abc' });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('preserves keys it was not asked to change', () => {
    const file = scratch();
    const store = createSecretStore(file);
    store.write({ ANTHROPIC_API_KEY: 'key', TELEGRAM_BOT_TOKEN: 'token' });
    store.write({ ANTHROPIC_API_KEY: 'replaced' });

    expect(store.read()).toEqual({ ANTHROPIC_API_KEY: 'replaced', TELEGRAM_BOT_TOKEN: 'token' });
  });

  it('reads an existing hand-written .env, so nobody is locked out', () => {
    const file = scratch();
    fs.writeFileSync(file, '# a comment\nANTHROPIC_API_KEY=from-hand\n\nEMPTY=\n');
    expect(createSecretStore(file).read()).toEqual({ ANTHROPIC_API_KEY: 'from-hand' });
  });
});

describe('env parsing', () => {
  it('skips comments, blanks and empty values, and strips quotes', () => {
    expect(parseEnv('# c\nA=1\n\nB="two"\nC=\nD=\'three\'\nnotakey\n')).toEqual({
      A: '1',
      B: 'two',
      D: 'three',
    });
  });
});

describe('data at rest', () => {
  it('writes owner-only, so a copied folder does not leak', () => {
    // The parent directory is 0700, which keeps other accounts out. These
    // modes matter for what escapes it: a Time Machine restore, a synced
    // folder, a support bundle. Mail subjects and login screenshots should
    // not become world-readable the moment they are copied out.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexa-modes-'));
    const store = new JsonStore<{ id: string }>(path.join(dir, 'tasks.json'));
    store.insert({ id: 'one' });

    expect(fs.statSync(path.join(dir, 'tasks.json')).mode & 0o777).toBe(0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
