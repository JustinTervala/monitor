import { build as bundle } from 'esbuild';
import { build as viteBuild } from 'vite';
import { copyRuntimeIcon } from './icons.mjs';

copyRuntimeIcon('dist-electron');

await bundle({
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
});
await bundle({
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
});
await viteBuild();
