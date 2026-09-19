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

/** The Nexa mark: a split square, the same shape used in the dashboard rail. */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="field" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2330"/>
      <stop offset="1" stop-color="#0d1117"/>
    </linearGradient>
  </defs>

  <rect x="96" y="96" width="832" height="832" rx="196" fill="url(#field)"/>
  <rect x="96" y="96" width="832" height="832" rx="196" fill="none"
        stroke="#ffffff" stroke-opacity="0.08" stroke-width="6"/>

  <!-- N as two uprights and a diagonal, drawn as solid bars -->
  <g fill="#e6edf3">
    <rect x="330" y="300" width="70" height="424" rx="14"/>
    <rect x="624" y="300" width="70" height="424" rx="14"/>
    <polygon points="400,300 470,300 694,640 694,724 624,724 400,384"/>
  </g>
  <rect x="330" y="300" width="70" height="424" rx="14" fill="#1f5fd0" fill-opacity="0.9"/>
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
