import { packager } from '@electron/packager';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkNotices, packageLicenses } from './licenses.mjs';

if (process.platform !== 'darwin') throw new Error('The first Monitor package targets macOS.');
checkNotices();
// Sign outside synced folders: macOS file providers can attach FinderInfo to
// app bundles in Documents even after the attribute has been removed.
const workspace = mkdtempSync(join(tmpdir(), 'monitor-package-'));
try {
  const staging = join(workspace, 'app');
  mkdirSync(staging);
  for (const path of ['dist', 'dist-electron'])
    cpSync(path, join(staging, path), { recursive: true });
  const source = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(
    join(staging, 'package.json'),
    JSON.stringify({
      name: source.name,
      version: source.version,
      main: source.main,
      description: source.description,
      license: source.license,
    }),
  );
  const paths = await packager({
    dir: staging,
    name: 'Monitor',
    out: join(workspace, 'out'),
    platform: 'darwin',
    arch: process.arch,
    electronVersion: JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8')).version,
    appBundleId: 'local.monitor.desktop',
    appCategoryType: 'public.app-category.productivity',
    // Required for macOS to ask before Monitor drives iTerm2 (Show/Resume in iTerm).
    extendInfo: {
      NSAppleEventsUsageDescription:
        'Monitor switches to, or opens, the iTerm2 tab for a Claude session when you ask it to.',
    },
    asar: true,
    overwrite: true,
    prune: false,
  });
  const appPath = join(paths[0], 'Monitor.app');
  packageLicenses(appPath);
  // Bind the renamed bundle's Info.plist and resources to a complete local
  // signature. This is ad-hoc signing, not notarized distribution.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  mkdirSync('out', { recursive: true });
  const archive = resolve('out', `Monitor-macos-${process.arch}.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, archive], {
    stdio: 'inherit',
  });
  console.log(
    `Built and verified: ${archive}\nExtract Monitor.app into ~/Applications or /Applications.`,
  );
} finally {
  rmSync(workspace, { recursive: true, force: true });
}
