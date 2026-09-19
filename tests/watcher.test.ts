import { describe, expect, it } from 'vitest';
import {
  captureState,
  createWatcher,
  detectChange,
  hashContent,
  normalizeContent,
  WatcherType,
} from '../src/watchers/Watcher';

describe('content normalisation', () => {
  it('strips the parts that change on every load', () => {
    const a = normalizeContent('Price: $49\nGenerated 2026-03-10T09:30:00Z\nsession=9f2b8c1d4e6a7b3c5d8e9f0a1b2c3d4e');
    const b = normalizeContent('Price: $49\nGenerated 2026-03-11T11:45:12Z\nsession=1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d');
    expect(a).toBe(b);
  });

  it('normalises relative times and cache busters', () => {
    const a = normalizeContent('Posted 5 minutes ago\n<img src="/logo.png?v=abc123">');
    const b = normalizeContent('Posted 2 hours ago\n<img src="/logo.png?v=zzz999">');
    expect(a).toBe(b);
  });

  it('keeps real content differences', () => {
    expect(normalizeContent('Price: $49')).not.toBe(normalizeContent('Price: $59'));
  });

  it('hashes stably', () => {
    expect(hashContent(normalizeContent('a\nb'))).toBe(hashContent(normalizeContent('a\nb')));
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});

describe('change detection', () => {
  it('treats the first reading as a baseline, not a change', () => {
    const result = detectChange(null, captureState('Price: $49'));
    expect(result.changed).toBe(false);
  });

  it('stays quiet when nothing moved', () => {
    const first = captureState('Price: $49\nIn stock');
    const second = captureState('Price: $49\nIn stock');
    expect(detectChange(first, second).changed).toBe(false);
  });

  it('reports a real change with a readable summary', () => {
    const first = captureState('Price: $49\nIn stock');
    const second = captureState('Price: $59\nIn stock');
    const result = detectChange(first, second);
    expect(result.changed).toBe(true);
    expect(result.added).toContain('Price: $59');
    expect(result.removed).toContain('Price: $49');
    expect(result.summary).toMatch(/added/);
  });

  it('ignores a change that misses the keywords', () => {
    const first = captureState('Price: $49\nFooter: copyright 2025');
    const second = captureState('Price: $49\nFooter: copyright 2026');
    expect(detectChange(first, second, ['price']).changed).toBe(false);
  });

  it('fires when a change does touch the keywords', () => {
    const first = captureState('Price: $49\nFooter: copyright 2025');
    const second = captureState('Price: $59\nFooter: copyright 2025');
    expect(detectChange(first, second, ['price']).changed).toBe(true);
  });

  it('does not fire on timestamp churn alone', () => {
    const first = captureState('Jobs: 3 open\nUpdated 2026-03-10T09:30:00Z');
    const second = captureState('Jobs: 3 open\nUpdated 2026-03-10T10:15:00Z');
    expect(detectChange(first, second).changed).toBe(false);
  });
});

describe('watcher creation', () => {
  it('starts active with a baseline yet to be taken', () => {
    const watcher = createWatcher({
      name: 'Pricing',
      type: WatcherType.PRICE,
      target: 'https://example.com/pricing',
      intervalSeconds: 3600,
    });
    expect(watcher.status).toBe('ACTIVE');
    expect(watcher.currentState).toBeNull();
    expect(watcher.nextCheck).not.toBeNull();
    expect(watcher.browserProfileId).toBe('default');
  });
});
