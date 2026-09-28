import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

// Fake the source protocol, not the UI. The production adapter and SQLite path
// are exercised unchanged; no real source tasks or Monitor preferences change.
const root = mkdtempSync('/tmp/monitor-ui-'),
  home = join(root, 'codex');
mkdirSync(join(home, 'ipc'), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(join(home, 'state_5.sqlite'));
db.exec(
  'CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)',
);
for (const [id, title, cwd, updated] of [
  ['aaaaaa', 'Build the billing rollout', '/work/payments', 3],
  ['bbbbbb', 'Review the billing changes', '/work/payments', 2],
  ['cccccc', 'Investigate streaming playback', '/work/media', 1],
])
  db.prepare("INSERT INTO threads VALUES(?,?,?,'cli',0,?)").run(id, title, cwd, updated);
db.close();
const clients = new Set();
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
const server = createServer((socket) => {
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  let bytes = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk]);
    while (bytes.length >= 4 && bytes.length >= bytes.readUInt32LE() + 4) {
      const size = bytes.readUInt32LE(),
        message = JSON.parse(bytes.subarray(4, size + 4).toString());
      bytes = bytes.subarray(size + 4);
      if (message.method === 'initialize')
        socket.write(
          frame({
            type: 'response',
            requestId: message.requestId,
            resultType: 'success',
            result: { clientId: 'observer' },
          }),
        );
      if (message.method === 'thread-stream-following-changed' && message.params.following) {
        const id = message.params.conversationId;
        socket.write(
          frame({
            type: 'broadcast',
            method: 'thread-stream-state-changed',
            version: 11,
            sourceClientId: 'fixture',
            params: {
              hostId: 'local',
              conversationId: id,
              change: {
                type: 'snapshot',
                revision: 1,
                conversationState: {
                  id,
                  hasUnreadTurn: id === 'bbbbbb',
                  threadRuntimeStatus: { type: id === 'aaaaaa' ? 'active' : 'idle' },
                  turns: [
                    {
                      turnId: `${id}-turn1`,
                      status: id === 'aaaaaa' ? 'inProgress' : 'completed',
                      turnStartedAtMs: 1,
                    },
                  ],
                },
              },
            },
          }),
        );
      }
    }
  });
});
await new Promise((resolve) => server.listen(join(home, 'ipc', 'ipc.sock'), resolve));
const env = { ...process.env, CODEX_HOME: home, MONITOR_DATA_DIR: join(root, 'monitor') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.MONITOR_DEV_URL;
let app;
try {
  app = await electron.launch({ args: ['.'], env });
  const page = await app.firstWindow(),
    errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('heading', { name: 'Your queue.' }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="group-row"]').length === 3,
  );
  await page.waitForFunction(
    async () =>
      (await window.monitor.snapshot()).state.sessions['codex:bbbbbb'].status === 'review',
  );
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Add tasks|Browse tasks/ }).count(), 0);
  await page.getByRole('button', { name: /Build the billing rollout.*1 running/ }).click();
  await page.getByRole('button', { name: 'Edit group', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Billing rollout');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const source = page.getByTestId('group-row').filter({ hasText: 'Review the billing changes' });
  const target = page.getByTestId('group-row').filter({ hasText: 'Billing rollout' });
  await source.dragTo(target);
  await page.getByRole('textbox', { name: 'Group name' }).fill('Billing rollout');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="group-row"]').length === 2,
  );
  assert.equal(await page.getByTestId('session-card').count(), 2);
  await page.getByLabel('Snooze workstream').selectOption('manual');
  assert.equal(
    await page
      .getByRole('region', { name: 'Snoozed', exact: true })
      .getByTestId('group-row')
      .count(),
    1,
  );
  await page.getByLabel('Snooze workstream').selectOption('active');
  assert.equal(
    await page
      .getByRole('region', { name: 'Needs review', exact: true })
      .getByTestId('group-row')
      .count(),
    1,
  );
  await page.getByRole('button', { name: 'Decrease priority', exact: true }).click();
  const snapshot = await page.evaluate(() => window.monitor.snapshot());
  assert.equal(snapshot.state.groups[1].name, 'Billing rollout');
  assert.equal(await page.getByRole('button', { name: 'Remove from Monitor' }).count(), 0);
  // A task created after startup appears and is followed without user action.
  const updatedCatalog = new DatabaseSync(join(home, 'state_5.sqlite'));
  updatedCatalog.exec(
    "INSERT INTO threads VALUES('dddddd','A newly created task','/work/project','cli',0,100)",
  );
  updatedCatalog.close();
  await page.waitForFunction(
    async () => {
      const value = await window.monitor.snapshot();
      return (
        value.state.groups.length === 3 && value.state.sessions['codex:dddddd']?.evidence === 'live'
      );
    },
    undefined,
    { timeout: 15000 },
  );
  await page.getByTestId('group-row').filter({ hasText: 'A newly created task' }).waitFor();
  const discovered = await page.evaluate(() => window.monitor.snapshot());
  assert.deepEqual(discovered.state.groups.slice(0, 2), snapshot.state.groups);
  assert.deepEqual(discovered.state.groups[2].sessionIds, ['codex:dddddd']);
  // Observe the navigation call without launching an invented Codex session.
  await app.evaluate(({ shell }) => {
    globalThis.monitorOpened = [];
    shell.openExternal = async (url) => {
      globalThis.monitorOpened.push(url);
    };
  });
  await page.getByRole('button', { name: 'Open in Codex ↗', exact: true }).first().click();
  assert.match(
    (await app.evaluate(() => globalThis.monitorOpened))[0],
    /^codex:\/\/threads\/[abc]{6}$/,
  );
  mkdirSync('.runtime', { recursive: true });
  await page.screenshot({ path: '.runtime/smoke.png' });
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  app = await electron.launch({ args: ['.'], env });
  const reopened = await app.firstWindow();
  await reopened.getByRole('heading', { name: 'Your queue.' }).waitFor();
  const persisted = await reopened.evaluate(() => window.monitor.snapshot());
  assert.equal(persisted.state.groups.length, 3);
  assert.equal(persisted.state.groups[1].name, 'Billing rollout');
  console.log(
    'Electron smoke passed: automatic discovery at startup and during execution, UI grouping, editing, snoozing, priority, session URL, persistence. Screenshot: .runtime/smoke.png',
  );
} finally {
  await app?.close();
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
