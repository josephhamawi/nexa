import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, 'dist/ui'), { recursive: true });
await cp(path.join(root, 'src/ui'), path.join(root, 'dist/ui'), {
  recursive: true,
  filter: (src) => !src.endsWith('.ts'),
});
// The dock icon is set at runtime in development; a packaged build gets its
// icon from electron-builder instead.
const iconSource = path.join(root, 'build/icon.png');
if (existsSync(iconSource)) {
  await cp(iconSource, path.join(root, 'dist/icon.png'));
  console.log('App icon copied to dist/icon.png');
}

console.log('UI assets copied to dist/ui');
