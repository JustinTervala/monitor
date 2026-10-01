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
const now = Math.floor(Date.now() / 1000);
for (const [id, title, cwd, updated] of [
  ['aaaaaa', 'Build the billing rollout', '/work/payments', now - 86400],
  ['bbbbbb', 'Review the billing changes', '/work/payments', now - 172800],
  ['cccccc', 'Investigate streaming playback', '/work/media', now - 604800],
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
const env = {
  ...process.env,
  CODEX_HOME: home,
  MONITOR_CODEX_HOOKS_DIR: join(root, 'codex-hooks'),
  MONITOR_DATA_DIR: join(root, 'monitor'),
  // Isolate from the real Claude desktop store; Claude is covered by its adapter tests.
  MONITOR_CLAUDE_DESKTOP_DIR: join(root, 'claude-desktop'),
  CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
  MONITOR_CLAUDE_HOOKS_DIR: join(root, 'claude-hooks'),
};
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
  // Queue shortcuts navigate directly without selecting a row or opening details.
  await app.evaluate(({ shell }) => {
    globalThis.monitorOpened = [];
    shell.openExternal = async (url) => {
      globalThis.monitorOpened.push(url);
    };
  });
  await page
    .getByRole('button', { name: 'Open in Codex: Build the billing rollout', exact: true })
    .click();
  assert.deepEqual(await app.evaluate(() => globalThis.monitorOpened), ['codex://threads/aaaaaa']);
  assert.equal(await page.getByRole('complementary', { name: 'Workstream details' }).count(), 0);
  const keyboardShortcut = page.getByRole('button', {
    name: 'Open in Codex: Review the billing changes',
    exact: true,
  });
  await keyboardShortcut.focus();
  await keyboardShortcut.press('Enter');
  assert.deepEqual(await app.evaluate(() => globalThis.monitorOpened), [
    'codex://threads/aaaaaa',
    'codex://threads/bbbbbb',
  ]);
  assert.equal(await page.getByRole('complementary', { name: 'Workstream details' }).count(), 0);
  await page.getByRole('button', { name: /Build the billing rollout.*1 running/ }).click();
  await page.getByRole('button', { name: 'Edit group', exact: true }).click();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Billing rollout');
  await page.getByRole('button', { name: 'Save changes' }).click();
  const source = page.getByTestId('group-row').filter({ hasText: 'Review the billing changes' });
  const target = page.getByTestId('group-row').filter({ hasText: 'Billing rollout' });
  // Aim at the row body, avoiding its actions, and cross the target twice so
  // Electron reliably receives dragover before drop.
  const sourceBox = await source.boundingBox(),
    targetBox = await target.boundingBox();
  await page.mouse.move(sourceBox.x + 90, sourceBox.y + 25);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 100, sourceBox.y + 25, { steps: 3 });
  await page.mouse.move(targetBox.x + 120, targetBox.y + 25, { steps: 12 });
  await page.mouse.move(targetBox.x + 135, targetBox.y + 25, { steps: 3 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Group name' }).fill('Billing rollout');
  await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="group-row"]').length === 2,
  );
  assert.equal(await page.getByTestId('session-card').count(), 2);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  await target.getByTestId('open-task').click();
  assert.equal(
    (await app.evaluate(() => globalThis.monitorOpened)).at(-1),
    'codex://threads/bbbbbb',
  );
  assert.equal(await page.getByRole('complementary', { name: 'Workstream details' }).count(), 0);
  // If both need review, prefer the task with newer source activity.
  for (const client of clients)
    client.write(
      frame({
        type: 'broadcast',
        method: 'thread-stream-state-changed',
        version: 11,
        sourceClientId: 'fixture',
        params: {
          hostId: 'local',
          conversationId: 'aaaaaa',
          change: {
            type: 'snapshot',
            revision: 2,
            conversationState: {
              id: 'aaaaaa',
              hasUnreadTurn: true,
              threadRuntimeStatus: { type: 'idle' },
              turns: [{ turnId: 'aaaaaa-turn1', status: 'completed', turnStartedAtMs: 1 }],
            },
          },
        },
      }),
    );
  await target
    .getByRole('button', { name: 'Open in Codex: Build the billing rollout', exact: true })
    .click();
  assert.equal(
    (await app.evaluate(() => globalThis.monitorOpened)).at(-1),
    'codex://threads/aaaaaa',
  );
  await target.locator('.row-select').click();
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
  updatedCatalog
    .prepare(
      "INSERT INTO threads VALUES('dddddd','A newly created task','/work/payments','cli',0,?)",
    )
    .run(now);
  const sourceBeforeArchive = updatedCatalog.prepare('SELECT * FROM threads ORDER BY id').all();
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
  await page.getByRole('button', { name: 'Archive workstream', exact: true }).click();
  await page.getByRole('button', { name: 'Archive A newly created task', exact: true }).click();
  await page
    .getByRole('button', { name: 'Archive Investigate streaming playback', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Your queue is clear.' }).waitFor();
  assert.equal(await page.getByTestId('group-row').count(), 0);
  await page.getByRole('button', { name: /^Archived / }).click();
  await page.getByRole('heading', { name: 'Archived.', exact: true }).waitFor();
  assert.equal(await page.getByTestId('archive-project').count(), 2);
  const archiveNames = () =>
    page
      .getByTestId('archive-row')
      .locator('.row-name')
      .evaluateAll((elements) => elements.map((e) => e.firstChild.textContent));
  assert.deepEqual(await archiveNames(), [
    'A newly created task',
    'Billing rollout',
    'Investigate streaming playback',
  ]);
  const payments = page.getByRole('button', { name: /payments.*\/work\/payments/ });
  await payments.click();
  assert.equal(await page.getByTestId('archive-row').filter({ visible: true }).count(), 1);
  await page.getByRole('textbox', { name: 'Filter workstreams' }).fill('billing');
  assert.equal(await page.getByTestId('archive-row').filter({ visible: true }).count(), 1);
  assert.deepEqual(await archiveNames(), ['Billing rollout']);
  await page.getByRole('textbox', { name: 'Filter workstreams' }).fill('no-matching-workstream');
  await page.getByRole('heading', { name: 'No matching workstreams' }).waitFor();
  await page.getByRole('textbox', { name: 'Filter workstreams' }).fill('');
  await payments.click();
  await page
    .getByTestId('archive-row')
    .filter({ hasText: 'Billing rollout' })
    .locator('.row-select')
    .click();
  assert.equal(await page.getByTestId('session-card').count(), 2);
  assert.equal(await page.getByRole('combobox').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Increase priority' }).count(), 0);
  await page.getByRole('button', { name: 'Open in Codex ↗', exact: true }).first().click();
  assert.equal((await app.evaluate(() => globalThis.monitorOpened)).length, 2);
  await page.screenshot({ path: '.runtime/archive-smoke.png' });
  // Restoring derives live section and returns to the original priority slot.
  await page.getByRole('button', { name: 'Restore to queue', exact: true }).click();
  await page.getByRole('heading', { name: 'Your queue.' }).waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Needs review', exact: true })
      .getByTestId('group-row')
      .count(),
    1,
  );
  assert.equal(await page.getByRole('button', { name: 'Increase priority' }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Decrease priority' }).isDisabled(), true);
  const restored = await page.evaluate(() => window.monitor.snapshot());
  assert.deepEqual(restored.state.groups[1], discovered.state.groups[1]);
  await page.getByRole('button', { name: 'Archive workstream', exact: true }).click();
  await page.getByRole('heading', { name: 'Your queue is clear.' }).waitFor();
  const sourceAfterArchive = new DatabaseSync(join(home, 'state_5.sqlite'), { readOnly: true });
  assert.deepEqual(
    sourceAfterArchive.prepare('SELECT * FROM threads ORDER BY id').all(),
    sourceBeforeArchive,
  );
  sourceAfterArchive.close();
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  app = await electron.launch({ args: ['.'], env });
  const reopened = await app.firstWindow();
  await reopened.getByRole('heading', { name: 'Your queue.' }).waitFor();
  const persisted = await reopened.evaluate(() => window.monitor.snapshot());
  assert.equal(persisted.state.groups.length, 3);
  assert.equal(persisted.state.groups[1].name, 'Billing rollout');
  assert.ok(persisted.state.groups.every((group) => group.archived));
  assert.equal(await reopened.getByTestId('group-row').count(), 0);
  await reopened.getByRole('button', { name: /^Archived / }).click();
  await reopened
    .getByRole('button', { name: 'Restore A newly created task to queue', exact: true })
    .click();
  await reopened
    .getByTestId('archive-row')
    .filter({ hasText: 'A newly created task' })
    .waitFor({ state: 'hidden' });
  assert.equal(await reopened.getByTestId('archive-row').count(), 2);
  await reopened.getByRole('button', { name: /^Queue / }).click();
  await reopened.getByTestId('group-row').filter({ hasText: 'A newly created task' }).waitFor();
  console.log(
    'Electron smoke passed: one-click and keyboard task navigation, group attention/recency selection, discovery, grouping, editing, snoozing, priority, project/recency archive, search, collapse, restore, source immutability, session URL, persistence. Screenshots: .runtime/smoke.png and .runtime/archive-smoke.png',
  );
} finally {
  await app?.close();
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
