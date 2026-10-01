import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { checkNotices, packageLicenses, thirdPartyNotices } from '../scripts/licenses.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'monitor-licenses-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const lock = { packages: { '': { license: 'MIT' } } };
  for (const [path, name, dev] of [
    ['node_modules/runtime', 'runtime', false],
    ['node_modules/runtime/node_modules/transitive', 'transitive', false],
    ['node_modules/build-tool', 'build-tool', true],
    ['node_modules/electron', 'electron', true],
    ['node_modules/vite', 'vite', true],
    ['node_modules/esbuild', 'esbuild', true],
  ]) {
    lock.packages[path] = { version: '1.0.0', dev };
    write(`${path}/package.json`, JSON.stringify({ name, version: '1.0.0', license: 'MIT' }));
    write(
      `${path}/${name === 'electron' ? 'dist/' : ''}LICENSE`,
      `Copyright ${name}\n\nPermission notice.\n`,
    );
  }
  write('node_modules/runtime/NOTICE', 'Additional attribution must survive.\n');
  write(
    'node_modules/electron/dist/LICENSES.chromium.html',
    '<html>Upstream third-party notices.\r\n</html>',
  );
  write('package-lock.json', JSON.stringify(lock));
  write('LICENSE', 'Monitor license text.\n');
  write(
    'assets/provider-icons/NOTICE.md',
    '## Provider icons\n\nBundled icon permission notice.\n',
  );
  return { root, write };
}

test('notices cover transitive packages, Electron and build helpers, preserving attribution', (t) => {
  const { root, write } = fixture(t);
  const notices = thirdPartyNotices(root);
  assert.match(notices, /## runtime 1\.0\.0/);
  assert.match(notices, /## transitive 1\.0\.0/);
  assert.match(notices, /## electron 1\.0\.0/);
  assert.match(notices, /## vite 1\.0\.0/);
  assert.match(notices, /## esbuild 1\.0\.0/);
  assert.match(notices, /Additional attribution must survive\./);
  assert.match(notices, /Bundled icon permission notice\./);
  assert.doesNotMatch(notices, /build-tool/);
  write('THIRD_PARTY_NOTICES.md', notices);
  const app = join(root, 'Monitor.app');
  packageLicenses(app, root);
  const target = join(app, 'Contents/Resources/licenses');
  for (const [source, name] of [
    ['LICENSE', 'Monitor-LICENSE.txt'],
    ['node_modules/electron/dist/LICENSE', 'Electron-LICENSE.txt'],
    ['node_modules/electron/dist/LICENSES.chromium.html', 'LICENSES.chromium.html'],
    ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'],
  ])
    assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(root, source)));
});

test('distribution rejects stale notices, unlocked versions and missing license text', (t) => {
  const { root, write } = fixture(t);
  write('THIRD_PARTY_NOTICES.md', thirdPartyNotices(root));
  write('node_modules/runtime/NOTICE', 'A new mandatory notice.\n');
  assert.throws(() => checkNotices(root), /stale/);
  assert.throws(() => packageLicenses(join(root, 'Monitor.app'), root), /stale/);
  write('assets/provider-icons/NOTICE.md', '');
  assert.throws(() => thirdPartyNotices(root), /Missing provider icon attribution/);
  write('assets/provider-icons/NOTICE.md', 'Updated icon permission notice.\n');
  write(
    'node_modules/runtime/package.json',
    JSON.stringify({ name: 'runtime', version: '2.0.0', license: 'MIT' }),
  );
  assert.throws(() => thirdPartyNotices(root), /does not match/);
  write(
    'node_modules/runtime/package.json',
    JSON.stringify({ name: 'runtime', version: '1.0.0', license: 'MIT' }),
  );
  rmSync(join(root, 'node_modules/runtime/node_modules/transitive/LICENSE'));
  assert.throws(() => thirdPartyNotices(root), /No license text found for transitive/);
});
