/**
 * Generates the application icon.
 *
 * Renders an SVG mark in Playwright's Chromium (already a dependency), writes
 * a 1024px PNG, then builds build/icon.icns via sips + iconutil on macOS.
 *
 *   node scripts/make-icon.mjs
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

/** The Nexa mark: an N whose diagonal carries a signal between two nodes. */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <!-- Deep slate field, lit from the top left like a physical object -->
    <linearGradient id="field" x1="0.15" y1="0" x2="0.85" y2="1">
      <stop offset="0" stop-color="#27313f"/>
      <stop offset="0.55" stop-color="#151c26"/>
      <stop offset="1" stop-color="#0b0f15"/>
    </linearGradient>

    <!-- The signal running through the mark -->
    <linearGradient id="signal" x1="0" y1="1" x2="1" y2="0">
      <stop offset="0" stop-color="#2f6fe0"/>
      <stop offset="0.5" stop-color="#5b9bff"/>
      <stop offset="1" stop-color="#8fc2ff"/>
    </linearGradient>

    <linearGradient id="edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="0.5" stop-color="#ffffff" stop-opacity="0.02"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.22"/>
    </linearGradient>

    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="18" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- macOS-style squircle -->
  <rect x="88" y="88" width="848" height="848" rx="196" fill="url(#field)"/>
  <rect x="88" y="88" width="848" height="848" rx="196" fill="url(#edge)"/>

  <!-- Faint grid: an instrument panel, not a toy -->
  <g stroke="#ffffff" stroke-opacity="0.045" stroke-width="2">
    <path d="M88 320h848M88 512h848M88 704h848M320 88v848M512 88v848M704 88v848"/>
  </g>

  <!-- The N: two uprights and a diagonal that carries the signal -->
  <g>
    <rect x="316" y="300" width="74" height="424" rx="16" fill="#e8eef6"/>
    <rect x="634" y="300" width="74" height="424" rx="16" fill="#e8eef6"/>
    <path d="M390 300 L390 404 L634 724 L634 620 Z" fill="url(#signal)" filter="url(#glow)"/>
  </g>

  <!-- Nodes: the agent taking a step, acting, arriving -->
  <circle cx="353" cy="300" r="34" fill="url(#signal)"/>
  <circle cx="671" cy="724" r="34" fill="url(#signal)"/>
  <circle cx="353" cy="300" r="15" fill="#0b0f15" fill-opacity="0.55"/>
  <circle cx="671" cy="724" r="15" fill="#0b0f15" fill-opacity="0.55"/>
</svg>
`;

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
  console.log(`wrote ${path.relative(root, png)}`);

  if (process.platform !== 'darwin') {
    console.log('not macOS, skipping .icns generation');
    return;
  }

  const iconset = path.join(buildDir, 'icon.iconset');
  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });

  const sizes = [16, 32, 64, 128, 256, 512, 1024];
  for (const size of sizes) {
    const targets = [];
    if (sizes.includes(size)) targets.push(`icon_${size}x${size}.png`);
    if (size > 16) targets.push(`icon_${size / 2}x${size / 2}@2x.png`);
    for (const name of targets) {
      if (name.startsWith('icon_1024x1024.png')) continue; // not a valid iconset entry
      await run('sips', ['-z', String(size), String(size), png, '--out', path.join(iconset, name)]);
    }
  }

  await run('iconutil', ['-c', 'icns', iconset, '-o', path.join(buildDir, 'icon.icns')]);
  await rm(iconset, { recursive: true, force: true });
  console.log(`wrote ${path.relative(root, path.join(buildDir, 'icon.icns'))}`);

  if (!existsSync(path.join(buildDir, 'icon.icns'))) {
    throw new Error('icon.icns was not produced');
  }
}

await writeFile(path.join(root, 'build', '.gitkeep'), '').catch(() => {});
await main();
