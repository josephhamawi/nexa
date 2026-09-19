import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * A watcher keeps an eye on something and reports meaningful change.
 *
 * "Meaningful" is the hard part: raw HTML churns constantly (session ids,
 * timestamps, ad slots, CSRF tokens), so comparison happens on normalised,
 * extracted content rather than on markup.
 */
export const WatcherType = {
  WEBSITE: 'WEBSITE',
  WEB_PAGE: 'WEB_PAGE',
  PRICE: 'PRICE',
  JOB_SEARCH: 'JOB_SEARCH',
  CONTENT: 'CONTENT',
  FILE: 'FILE',
  CUSTOM: 'CUSTOM',
} as const;

export type WatcherType = (typeof WatcherType)[keyof typeof WatcherType];

export const WatcherStatus = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  ERROR: 'ERROR',
  WAITING_FOR_HUMAN: 'WAITING_FOR_HUMAN',
} as const;

export type WatcherStatus = (typeof WatcherStatus)[keyof typeof WatcherStatus];

export interface WatcherState {
  /** Normalised text the comparison actually runs on. */
  content: string;
  /** Stable digest of `content`, for a cheap equality check. */
  hash: string;
  capturedAt: string;
  /** Structured values pulled out, e.g. prices or job titles. */
  items?: string[];
}

export interface Watcher {
  id: string;
  name: string;
  description: string;
  type: WatcherType;
  /** URL, search query or directory, depending on type. */
  target: string;
  /** Optional CSS selector to narrow the comparison to one region. */
  selector: string | null;
  /** Optional keywords; a change only counts if it touches one of these. */
  keywords: string[];
  intervalSeconds: number;
  status: WatcherStatus;
  createdAt: string;
  lastChecked: string | null;
  lastChanged: string | null;
  nextCheck: string | null;
  currentState: WatcherState | null;
  previousState: WatcherState | null;
  changeSummary: string | null;
  consecutiveErrors: number;
  lastError: string | null;
  notifyOnChange: boolean;
  /** Browser profile used when the target needs a real session. */
  browserProfileId: string;
  source: 'telegram' | 'desktop' | 'system';
  sourceChatId?: string | null;
}

export interface CreateWatcherInput {
  name: string;
  description?: string;
  type: WatcherType;
  target: string;
  selector?: string | null;
  keywords?: string[];
  intervalSeconds: number;
  browserProfileId?: string;
  notifyOnChange?: boolean;
  source?: Watcher['source'];
  sourceChatId?: string | null;
}

export function createWatcher(input: CreateWatcherInput): Watcher {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? '',
    type: input.type,
    target: input.target,
    selector: input.selector ?? null,
    keywords: input.keywords ?? [],
    intervalSeconds: input.intervalSeconds,
    status: WatcherStatus.ACTIVE,
    createdAt: now,
    lastChecked: null,
    lastChanged: null,
    nextCheck: new Date(Date.now() + 5000).toISOString(),
    currentState: null,
    previousState: null,
    changeSummary: null,
    consecutiveErrors: 0,
    lastError: null,
    notifyOnChange: input.notifyOnChange ?? true,
    browserProfileId: input.browserProfileId ?? 'default',
    source: input.source ?? 'desktop',
    sourceChatId: input.sourceChatId ?? null,
  };
}

/**
 * Strips the parts of a page that differ on every single load.
 *
 * Without this a watcher fires constantly on clocks, nonces and cache-busting
 * query strings, and you quickly stop reading its notifications.
 */
export function normalizeContent(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    // timestamps and dates
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?Z?\b/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b/gi, '<time>')
    // ids, tokens and cache busters
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<hash>')
    .replace(/([?&])(_|v|ts|cb|nonce|token|sid)=[^&\s]+/gi, '$1$2=<x>')
    // visitor counters and "x minutes ago"
    .replace(/\b\d+\s+(seconds?|minutes?|hours?|days?)\s+ago\b/gi, '<relative>')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

export function hashContent(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}

export function captureState(raw: string, items?: string[]): WatcherState {
  const content = normalizeContent(raw);
  return {
    content,
    hash: hashContent(content),
    capturedAt: new Date().toISOString(),
    ...(items ? { items } : {}),
  };
}

export interface ChangeDetection {
  changed: boolean;
  /** Human-readable description, or null when nothing meaningful moved. */
  summary: string | null;
  added: string[];
  removed: string[];
}

/**
 * Compares two captures.
 *
 * Line-level diff on normalised content, then, when keywords are configured,
 * a relevance filter so unrelated edits on a busy page stay quiet.
 */
export function detectChange(
  previous: WatcherState | null,
  current: WatcherState,
  keywords: string[] = [],
): ChangeDetection {
  if (!previous) {
    return { changed: false, summary: null, added: [], removed: [] };
  }
  if (previous.hash === current.hash) {
    return { changed: false, summary: null, added: [], removed: [] };
  }

  const before = new Set(previous.content.split('\n'));
  const after = new Set(current.content.split('\n'));

  let added = [...after].filter((line) => !before.has(line));
  let removed = [...before].filter((line) => !after.has(line));

  if (keywords.length > 0) {
    const matches = (line: string): boolean =>
      keywords.some((word) => line.toLowerCase().includes(word.toLowerCase()));
    added = added.filter(matches);
    removed = removed.filter(matches);
    if (added.length === 0 && removed.length === 0) {
      return { changed: false, summary: null, added: [], removed: [] };
    }
  }

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, summary: null, added: [], removed: [] };
  }

  const parts: string[] = [];
  if (added.length > 0) parts.push(`${added.length} line(s) added`);
  if (removed.length > 0) parts.push(`${removed.length} line(s) removed`);
  const sample = added[0] ?? removed[0] ?? '';

  return {
    changed: true,
    summary: `${parts.join(', ')}. First change: ${sample.slice(0, 160)}`,
    added: added.slice(0, 25),
    removed: removed.slice(0, 25),
  };
}
