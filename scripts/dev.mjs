import { build } from 'esbuild';
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';
import { copyRuntimeIcon } from './icons.mjs';

copyRuntimeIcon('dist-electron');

await build({
  entryPoints: ['src/main/main.ts'],
  outfile: 'dist-electron/main.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
});
await build({
  entryPoints: ['src/main/preload.ts'],
  outfile: 'dist-electron/preload.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['electron'],
  sourcemap: true,
});
const server = await createServer();
await server.listen();
const env = { ...process.env, MONITOR_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
async function cleanup(code = 0) {
  child.kill();
  await server.close();
  process.exit(code);
}
child.on('exit', (code) => void cleanup(code ?? 0));
process.on('SIGINT', () => void cleanup());
process.on('SIGTERM', () => void cleanup());
