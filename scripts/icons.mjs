import { cpSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(
  new URL('../assets/icon-concepts/lizards/watchkeeper-v1.png', import.meta.url),
);

export function copyRuntimeIcon(directory) {
  mkdirSync(directory, { recursive: true });
  cpSync(source, join(directory, 'icon.png'));
}

export function createMacIcon(directory) {
  const iconset = join(directory, 'Monitor.iconset');
  mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      execFileSync('/usr/bin/sips', ['-z', pixels, pixels, source, '--out', join(iconset, name)], {
        stdio: 'pipe',
      });
    }
  }
  const icon = join(directory, 'Monitor.icns');
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', icon, iconset]);
  return icon;
}
