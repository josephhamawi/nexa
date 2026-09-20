/**
 * Generates the application icon.
 *
 *   node scripts/make-icon.mjs        # default variant
 *   node scripts/make-icon.mjs c      # pick another
 *
 * Renders the mark in Playwright's Chromium (already a dependency), writes a
 * 1024px PNG, then builds build/icon.icns via sips + iconutil on macOS.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium } from 'playwright';

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(root, 'build');

/**
 * The mark: a geometric N whose diagonal runs the full height.
 *
 * The diagonal must start at the very top of the left stem and finish at the
 * very bottom of the right one. Stopping it short reads as a slash between two
 * bars rather than a letter, which is the usual way this shape goes wrong.
 */
const L = 318;
const R = 626;
const W = 80;
const TOP = 288;
const BOT = 736;
const THICK = 132;

const stems = `
  <rect x="${L}" y="${TOP}" width="${W}" height="${BOT - TOP}" rx="16"/>
  <rect x="${R}" y="${TOP}" width="${W}" height="${BOT - TOP}" rx="16"/>`;
const diagonal = `<polygon points="${L + W},${TOP} ${L + W},${TOP + THICK} ${R + W},${BOT} ${R + W},${BOT - THICK}"/>`;

/** Light from above, shadow below: makes the tile read as a physical object. */
const SHEEN = `
  <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity="0.26"/>
    <stop offset="0.5" stop-color="#fff" stop-opacity="0.03"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.22"/>
  </linearGradient>`;

const tile = (fill, extra = '') => `
  <rect x="96" y="96" width="832" height="832" rx="196" fill="${fill}"/>
  <rect x="96" y="96" width="832" height="832" rx="196" fill="url(#sheen)"/>${extra}`;

const VARIANTS = {
  /** Warm amber to crimson. Chosen because it survives a dock full of dark and
   *  blue icons, which is where this one actually has to compete. */
  b: `<defs>${SHEEN}
      <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#fcd34d"/>
        <stop offset="0.45" stop-color="#f97316"/>
        <stop offset="1" stop-color="#e11d48"/>
      </linearGradient></defs>
    ${tile('url(#field)')}
    <g fill="#180d06">${stems}${diagonal}</g>`,

  /** Violet to blue, solid white mark. Calmer, more conventional. */
  a: `<defs>${SHEEN}
      <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#8b5cf6"/>
        <stop offset="0.5" stop-color="#4f46e5"/>
        <stop offset="1" stop-color="#1d4ed8"/>
      </linearGradient></defs>
    ${tile('url(#field)')}
    <g fill="#fff">${stems}${diagonal}</g>`,

  /** Near-black with the diagonal lit like a signal in transit. */
  c: `<defs>${SHEEN}
      <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#232b39"/><stop offset="1" stop-color="#05070c"/>
      </linearGradient>
      <linearGradient id="signal" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#a3e635"/>
      </linearGradient>
      <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="16" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter></defs>
    ${tile(
      'url(#field)',
      '<rect x="96" y="96" width="832" height="832" rx="196" fill="none" stroke="#a3e635" stroke-opacity="0.18" stroke-width="7"/>',
    )}
    <g fill="#eef2f7">${stems}</g>
    <g fill="url(#signal)" filter="url(#glow)">${diagonal}</g>`,
};

const variant = (process.argv[2] ?? 'b').toLowerCase();
const body = VARIANTS[variant];

if (!body) {
  console.error(`Unknown variant "${variant}". Available: ${Object.keys(VARIANTS).join(', ')}`);
  process.exit(1);
}

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`;

async function main() {
  await mkdir(buildDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${SVG}</body></html>`,
  );
  const png = path.join(buildDir, 'icon.png');
  await page.screenshot({ path: png, omitBackground: true });
  await browser.close();
  console.log(`wrote ${path.relative(root, png)} (variant ${variant})`);

  if (process.platform !== 'darwin') {
    console.log('not macOS, skipping .icns generation');
    return;
  }

  const iconset = path.join(buildDir, 'icon.iconset');
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });

  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    const names = [`icon_${size}x${size}.png`];
    if (size > 16) names.push(`icon_${size / 2}x${size / 2}@2x.png`);
    for (const name of names) {
      if (name.startsWith('icon_1024x1024.png')) continue; // not a valid iconset entry
      await run('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, name)]);
    }
  }

  await run('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  await rm(iconset, { recursive: true, force: true });
  console.log(`wrote ${path.relative(root, path.join(buildDir, 'icon.icns'))}`);

  if (!existsSync(path.join(buildDir, 'icon.icns'))) throw new Error('icon.icns was not produced');
}

await writeFile(path.join(root, 'build', '.gitkeep'), '').catch(() => {});
await main();
