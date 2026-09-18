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

/** Red field, gold band, three bars, the same seal as the dashboard masthead. */
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="field" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#bf2d26"/>
      <stop offset="1" stop-color="#8d1a17"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
      <stop offset="0.45" stop-color="#ffffff" stop-opacity="0.04"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.12"/>
    </linearGradient>
  </defs>

  <rect x="96" y="96" width="832" height="832" rx="196" fill="url(#field)"/>
  <rect x="96" y="96" width="832" height="832" rx="196" fill="url(#sheen)"/>
  <rect x="96" y="96" width="832" height="832" rx="196" fill="none"
        stroke="#f4f0e8" stroke-opacity="0.18" stroke-width="6"/>

  <!-- gold band -->
  <rect x="96" y="452" width="832" height="120" fill="#d8a93f" fill-opacity="0.95"/>

  <!-- three bars: the seal from the masthead -->
  <g fill="#f7f2e8">
    <rect x="336" y="300" width="56" height="424" rx="16"/>
    <rect x="484" y="248" width="56" height="528" rx="16"/>
    <rect x="632" y="300" width="56" height="424" rx="16"/>
  </g>
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
