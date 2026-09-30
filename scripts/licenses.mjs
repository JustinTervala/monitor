import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Include the complete production dependency graph, including transitive packages. */
export function thirdPartyNotices(root = projectRoot) {
  const lock = json(join(root, 'package-lock.json'));
  const entries = Object.entries(lock.packages).filter(([path, metadata]) => path && !metadata.dev);
  // Electron is a build dependency in npm, but its runtime ships in the app.
  const electronPath = 'node_modules/electron';
  if (!entries.some(([path]) => path === electronPath))
    entries.push([electronPath, lock.packages[electronPath]]);
  const packages = entries.map(([path, pinned]) => {
    if (!pinned) throw new Error(`Missing lockfile entry for ${path}. Run npm ci.`);
    const directory = join(root, path);
    const installed = json(join(directory, 'package.json'));
    if (installed.version !== pinned.version)
      throw new Error(`Installed ${installed.name} does not match package-lock.json. Run npm ci.`);
    if (!installed.license) throw new Error(`Missing license metadata for ${installed.name}.`);
    const licenseDirectory = path === electronPath ? join(directory, 'dist') : directory;
    const files = readdirSync(licenseDirectory)
      .filter((name) => /^(licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(name))
      // This large upstream file is copied byte-for-byte beside the notices.
      .filter((name) => name !== 'LICENSES.chromium.html')
      .sort();
    if (!files.some((name) => /^(licen[cs]e|copying)(?:[._-].*)?$/i.test(name)))
      throw new Error(`No license text found for ${installed.name}. Refusing to omit its notice.`);
    return {
      name: installed.name,
      version: installed.version,
      license: installed.license,
      files: files.map((name) => {
        const text = readFileSync(join(licenseDirectory, name), 'utf8');
        if (!text.trim()) throw new Error(`Empty license file: ${path}/${name}`);
        return { name, text };
      }),
    };
  });
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const sections = packages.map(
    (pkg) =>
      `## ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license}\n\n` +
      pkg.files
        .map((file) => `### ${file.name}\n\n\`\`\`text\n${file.text.trimEnd()}\n\`\`\`\n`)
        .join('\n'),
  );
  return [
    '# Third-party notices',
    '',
    'Generated with `npm run licenses` from the installed versions pinned in `package-lock.json`.',
    'These notices cover Monitor’s production dependency graph and the Electron runtime. Build-only tools are not redistributed in the app.',
    '',
    'The packaged app also includes Electron’s complete upstream `LICENSES.chromium.html` unchanged, covering Chromium and its bundled third-party components. Find it beside these notices in `Monitor.app/Contents/Resources/licenses/`.',
    '',
    'Monitor’s own source code is licensed separately under the MIT license in `LICENSE`. The original copyright and permission notices below continue to apply to their respective components.',
    '',
    ...sections,
  ].join('\n');
}

export function checkNotices(root = projectRoot) {
  const expected = thirdPartyNotices(root);
  if (readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8') !== expected)
    throw new Error('Third-party notices are stale. Run npm run licenses and commit the update.');
  return expected;
}

/** Add notices before code signing so they are covered by the app signature. */
export function packageLicenses(appPath, root = projectRoot) {
  const notices = checkNotices(root);
  const target = join(appPath, 'Contents', 'Resources', 'licenses');
  mkdirSync(target, { recursive: true });
  const copies = [
    [join(root, 'LICENSE'), 'Monitor-LICENSE.txt'],
    [join(root, 'node_modules/electron/dist/LICENSE'), 'Electron-LICENSE.txt'],
    [join(root, 'node_modules/electron/dist/LICENSES.chromium.html'), 'LICENSES.chromium.html'],
  ];
  for (const [source, name] of copies) {
    if (!readFileSync(source).length) throw new Error(`Empty license file: ${source}`);
    cpSync(source, join(target, name));
    if (!readFileSync(source).equals(readFileSync(join(target, name))))
      throw new Error(`Packaged license does not match its source: ${name}`);
  }
  writeFileSync(join(target, 'THIRD_PARTY_NOTICES.md'), notices);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    checkNotices();
    console.log('Third-party notices match installed, locked runtime dependencies.');
  } else {
    writeFileSync(join(projectRoot, 'THIRD_PARTY_NOTICES.md'), thirdPartyNotices());
    console.log('Updated THIRD_PARTY_NOTICES.md.');
  }
}
