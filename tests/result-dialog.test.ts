// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The dashboard had no tests at all, and the result dialog is pure DOM: the
 * only way to know the button is wired to the markup is to load the real
 * index.html and the real renderer.js together and click it.
 */
const uiDir = path.join(process.cwd(), 'src', 'ui');

const openEvidence = vi.fn(async () => ({ ok: true }));
const copyText = vi.fn(async () => ({ ok: true }));

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    name: 'check my mail for new mails today',
    naturalLanguageRequest: 'check my mail for new mails today',
    status: 'COMPLETED',
    progress: 100,
    steps: [],
    evidence: [],
    result: 'FULL RESULT LINE 1\n' + 'x'.repeat(3000),
    lastRun: new Date().toISOString(),
    confidence: { level: 'low', score: 34, factors: [] },
    recurrence: { kind: 'once' },
    ...overrides,
  };
}

beforeAll(async () => {
  // jsdom has no matchMedia, and the renderer reads it for the theme toggle.
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    writable: true,
  });

  Object.defineProperty(window, 'nexa', {
    value: {
      openEvidence,
      copyText,
      getState: async () => ({}),
      onState: () => undefined,
      onActivity: () => undefined,
    },
    writable: true,
  });

  // Evaluating renderer.js also starts boot(), which needs a live agent and
  // rejects. Its catch handler replaces document.body with an error page, so
  // the markup has to go in *after* that has happened, not before.
  const code = fs.readFileSync(path.join(uiDir, 'assets', 'renderer.js'), 'utf8');
  (0, eval)(code);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Take the real <body> out of the real index.html, so the test is wired to
  // the markup that actually ships rather than a fixture that can drift.
  const html = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
  const body = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!body) throw new Error('index.html has no <body>');
  document.body.innerHTML = body[1]!.replace(/<script[\s\S]*?<\/script>/gi, '');

  // jsdom does not implement <dialog>.showModal/close. Electron's Chromium
  // does, so shim the open/close state here: what is under test is the wiring
  // around the dialog, not the browser's dialog implementation.
  const dialog = document.getElementById('result-dialog') as HTMLDialogElement;
  dialog.showModal = function showModal(): void {
    this.setAttribute('open', '');
  };
  dialog.close = function close(): void {
    this.removeAttribute('open');
    this.dispatchEvent(new window.Event('close'));
  };

  (globalThis as unknown as { wireResultDialog(): void }).wireResultDialog();
});

beforeEach(() => {
  openEvidence.mockClear();
  copyText.mockClear();
  const dialog = document.getElementById('result-dialog') as HTMLDialogElement;
  if (dialog.open) dialog.close();
});

function renderOne(item: ReturnType<typeof task>): HTMLElement {
  const host = document.createElement('div');
  (globalThis as unknown as { renderTaskList(c: Element, t: unknown[], e: null): void }).renderTaskList(
    host,
    [item],
    null,
  );
  return host;
}

describe('result dialog', () => {
  it('puts a Show button on a task that produced a result', () => {
    const labels = [...renderOne(task()).querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toContain('Show');
  });

  it('leaves it off a task with no result to show', () => {
    const labels = [...renderOne(task({ result: '' })).querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).not.toContain('Show');
  });

  it('opens the dialog with the whole result, not the clipped preview', () => {
    const item = task();
    const host = renderOne(item);

    const preview = host.querySelector('.record-result') as HTMLElement;
    expect(preview.textContent).toHaveLength(1200);

    const show = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Show') as HTMLButtonElement;
    show.click();

    const dialog = document.getElementById('result-dialog') as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(document.getElementById('result-dialog-body')?.textContent).toBe(item.result);
    expect(document.getElementById('result-dialog-title')?.textContent).toBe(item.name);
    expect(document.getElementById('result-dialog-sub')?.textContent).toMatch(/Completed/i);
    expect(document.getElementById('result-dialog-sub')?.textContent).toMatch(/confidence 34%/);
  });

  it('opens from the clipped preview too, by click and by keyboard', () => {
    const dialog = document.getElementById('result-dialog') as HTMLDialogElement;

    const preview = renderOne(task()).querySelector('.record-result') as HTMLElement;
    expect(preview.getAttribute('role')).toBe('button');
    expect(preview.getAttribute('tabindex')).toBe('0');

    preview.click();
    expect(dialog.open).toBe(true);
    dialog.close();

    preview.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(dialog.open).toBe(true);
  });

  it('lists evidence files and opens the one you pick', () => {
    const item = task({
      evidence: [
        { id: 'e1', kind: 'screenshot', title: 'Inbox', path: '/tmp/a.png' },
        { id: 'e2', kind: 'data', title: 'No file here' },
      ],
    });
    const show = [...renderOne(item).querySelectorAll('button')].find(
      (b) => b.textContent === 'Show',
    ) as HTMLButtonElement;
    show.click();

    const rows = document.querySelectorAll('.result-dialog-evidence-row');
    expect(rows).toHaveLength(1); // the one without a path is not openable
    (rows[0]?.querySelector('button') as HTMLButtonElement).click();
    expect(openEvidence).toHaveBeenCalledWith('/tmp/a.png');
  });

  it('copies the full result, not the preview', async () => {
    const item = task();
    const show = [...renderOne(item).querySelectorAll('button')].find(
      (b) => b.textContent === 'Show',
    ) as HTMLButtonElement;
    show.click();

    (document.getElementById('result-dialog-copy') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(copyText).toHaveBeenCalledWith(item.result);
  });

  it('closes on the Close button and on a backdrop click', () => {
    const dialog = document.getElementById('result-dialog') as HTMLDialogElement;
    const show = [...renderOne(task()).querySelectorAll('button')].find(
      (b) => b.textContent === 'Show',
    ) as HTMLButtonElement;

    show.click();
    (document.getElementById('result-dialog-close') as HTMLButtonElement).click();
    expect(dialog.open).toBe(false);

    show.click();
    dialog.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it('says so plainly when a task completed with nothing to show', () => {
    (globalThis as unknown as { showResult(t: unknown): void }).showResult(task({ result: '' }));
    expect(document.getElementById('result-dialog-body')?.textContent).toMatch(/no result text/i);
  });
});
