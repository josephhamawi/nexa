import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { PROBE_SELECTORS, type PageSnapshot } from '../../src/bls/BlsPageDetector';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

export function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

/**
 * Builds the same PageSnapshot shape the adapter produces in a real browser,
 * but from a static HTML fixture. jsdom has no layout engine, so visibility is
 * approximated: an element counts as visible unless it is a hidden input or
 * carries an explicit display:none / hidden attribute.
 */
export function snapshotFromHtml(
  html: string,
  url: string,
  httpStatus: number | null = 200,
): PageSnapshot {
  const dom = new JSDOM(html, { url });
  const { document } = dom.window;

  const isVisible = (el: Element): boolean => {
    let node: Element | null = el;
    while (node) {
      const element = node as HTMLElement;
      if (element.hasAttribute?.('hidden')) return false;
      if (element.getAttribute?.('type') === 'hidden') return false;
      const style = element.getAttribute?.('style') ?? '';
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) return false;
      node = node.parentElement;
    }
    return true;
  };

  const visibleMatches: string[] = [];
  for (const selector of PROBE_SELECTORS) {
    try {
      const nodes = Array.from(document.querySelectorAll(selector));
      if (nodes.some(isVisible)) visibleMatches.push(selector);
    } catch {
      // ignore selectors jsdom cannot parse
    }
  }

  const iframes = Array.from(document.querySelectorAll('iframe')).map((frame) => ({
    src: frame.getAttribute('src') ?? '',
    title: frame.getAttribute('title') ?? '',
  }));

  return {
    url,
    title: document.title,
    visibleText: extractText(document.body),
    visibleMatches,
    iframes,
    httpStatus,
  };
}

export function snapshotFromFixture(
  name: string,
  url = 'https://nigeria.blsspainglobal.com/Global/blsappointment/MyAppointments',
  httpStatus: number | null = 200,
): PageSnapshot {
  return snapshotFromHtml(readFixture(name), url, httpStatus);
}

/** Rough innerText equivalent: block elements produce line breaks. */
function extractText(root: Element | null): string {
  if (!root) return '';
  const blocks = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'DL', 'DT', 'DD', 'FIELDSET',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TR',
    'TD', 'TH', 'UL', 'BR', 'OPTION', 'LABEL', 'BUTTON', 'A',
  ]);

  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ');
      if (text.trim()) parts.push(text);
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return;
    if (element.hasAttribute('hidden')) return;

    if (blocks.has(tag)) parts.push('\n');
    for (const child of Array.from(node.childNodes)) walk(child);
    if (blocks.has(tag)) parts.push('\n');
  };

  walk(root);

  return parts
    .join(' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
