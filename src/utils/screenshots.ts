import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';
import { ensureDataDirs, paths } from '../config/config';
import { fileTimestamp } from './time';
import { childLogger } from '../logging/logger';

const log = childLogger('screenshots');

export type ScreenshotEvent =
  | 'appointment-found'
  | 'captcha'
  | 'login-required'
  | 'session-expired'
  | 'unexpected-page'
  | 'site-error'
  | 'structure-changed'
  | 'lagos-selection-error'
  | 'visa-category-not-found'
  | 'diagnostics'
  | 'manual';

/** data/screenshots/bls-spain-lagos/YYYY-MM-DD_HH-mm-ss_event.png */
export function screenshotPathFor(event: ScreenshotEvent, when: Date = new Date()): string {
  ensureDataDirs();
  return path.join(paths.screenshots, `${fileTimestamp(when)}_${event}.png`);
}

/**
 * Best-effort capture. A failed screenshot must never break a check, so this
 * swallows errors and returns null instead of throwing.
 */
export async function captureScreenshot(
  page: Page | null | undefined,
  event: ScreenshotEvent,
): Promise<string | null> {
  if (!page || page.isClosed()) return null;
  const target = screenshotPathFor(event);
  try {
    await page.screenshot({ path: target, fullPage: true });
    log.info({ event, file: path.basename(target) }, 'screenshot captured');
    return target;
  } catch (err) {
    log.warn({ event, err: (err as Error).message }, 'screenshot failed');
    return null;
  }
}

export function listScreenshots(limit = 50): { file: string; path: string; mtime: number }[] {
  ensureDataDirs();
  if (!fs.existsSync(paths.screenshots)) return [];
  return fs
    .readdirSync(paths.screenshots)
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const full = path.join(paths.screenshots, f);
      return { file: f, path: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
}
