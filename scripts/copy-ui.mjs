import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, 'dist/ui'), { recursive: true });
await cp(path.join(root, 'src/ui'), path.join(root, 'dist/ui'), {
  recursive: true,
  filter: (src) => !src.endsWith('.ts'),
});
console.log('UI assets copied to dist/ui');
