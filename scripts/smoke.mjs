import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
  ['cccccc', 'Investigate streaming playback', '/work/media', now - 518400],
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
                  hasUnreadTurn: [
                    'bbbbbb',
                    'dddddd',
                    'fork-inval',
                    'fork-ttl00',
                    'fork-index',
                  ].includes(id),
                  threadRuntimeStatus: {
                    type: ['aaaaaa', 'fork-stale', 'fork-bench'].includes(id) ? 'active' : 'idle',
                  },
                  turns: [
                    {
                      turnId: `${id}-turn1`,
                      status: ['aaaaaa', 'fork-stale', 'fork-bench'].includes(id)
                        ? 'inProgress'
                        : 'completed',
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
  assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors), true);
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    'dark',
  );
  mkdirSync('.runtime', { recursive: true });
  await page.screenshot({ path: '.runtime/midnight-statuses.png' });
  assert.equal(await page.locator('select').count(), 0);
  assert.equal(
    await page.getByRole('button', { name: 'Read', exact: true }).getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(
    await page
      .getByTestId('group-row')
      .filter({ hasText: 'Investigate streaming playback' })
      .isVisible(),
    true,
  );
  assert.equal(await page.getByRole('button', { name: /Add tasks|Browse tasks/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: /^View fork family:/ }).count(), 0);
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
  // The task row itself opens details, even when there is no fork metadata.
  const billingTask = page.getByRole('button', {
    name: 'View task: Build the billing rollout',
    exact: true,
  });
  await billingTask.focus();
  await billingTask.press('Enter');
  const initialTaskView = page.getByRole('main', { name: 'Task view' });
  await initialTaskView
    .getByRole('heading', { name: 'Build the billing rollout', exact: true })
    .waitFor();
  assert.equal(
    await initialTaskView.getByRole('region', { name: 'Fork family', exact: true }).count(),
    0,
  );
  assert.equal(await initialTaskView.getByRole('navigation', { name: 'Task sections' }).count(), 0);
  assert.equal(
    await initialTaskView.getByRole('complementary', { name: 'Task details' }).count(),
    1,
  );
  assert.deepEqual(
    await initialTaskView
      .getByRole('navigation', { name: 'Task breadcrumbs' })
      .getByRole('button')
      .allTextContents(),
    ['Queue'],
  );
  await initialTaskView.getByRole('button', { name: 'View group →', exact: true }).click();
  await page.getByRole('button', { name: 'Edit group', exact: true }).click();
  await page.getByRole('dialog').screenshot({ path: '.runtime/midnight-editor.png' });
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
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="group-row"]').length === 2,
  );
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByTestId('session-card').count(), 2);
  await page.getByRole('button', { name: 'Close details', exact: true }).click();
  const priorityBeforeSearch = (await page.evaluate(() => window.monitor.snapshot())).state.groups;
  await page.getByRole('textbox', { name: 'Filter workstreams' }).fill('paymnts billign');
  assert.equal(await page.getByTestId('group-row').count(), 1);
  await target.waitFor();
  await page.getByRole('textbox', { name: 'Filter workstreams' }).fill('');
  assert.deepEqual(
    (await page.evaluate(() => window.monitor.snapshot())).state.groups,
    priorityBeforeSearch,
  );
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
  await page
    .getByRole('region', { name: 'Snoozed', exact: true })
    .getByTestId('group-row')
    .waitFor();
  assert.equal(
    await page
      .getByRole('region', { name: 'Snoozed', exact: true })
      .getByTestId('group-row')
      .count(),
    1,
  );
  await page.getByLabel('Snooze workstream').selectOption('active');
  await page
    .getByRole('region', { name: 'Needs review', exact: true })
    .getByTestId('group-row')
    .waitFor();
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
  // Missing runtime keeps last-known placement and is qualified inline.
  for (const client of clients)
    client.write(
      frame({
        type: 'broadcast',
        method: 'thread-stream-state-changed',
        version: 11,
        sourceClientId: 'fixture',
        params: {
          hostId: 'local',
          conversationId: 'dddddd',
          change: {
            type: 'snapshot',
            revision: 2,
            conversationState: { id: 'dddddd' },
          },
        },
      }),
    );
  await page
    .getByTestId('group-row')
    .filter({ hasText: 'A newly created task' })
    .getByText('· Status unavailable', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('region', { name: 'Status unavailable', exact: true }).count(),
    0,
  );
  assert.deepEqual(await page.locator('.queue-section h2').allTextContents(), [
    'Needs review',
    'Running',
    'Read',
  ]);
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
  await page.getByRole('textbox', { name: 'Filter workstreams' }).fill('reveiw billign');
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
  // Exercise production CLI observation and IPC actions. Stub only the OS boundary;
  // never focus or resume a real personal session during a fixture test.
  const cliId = '00000000-0000-4000-8000-000000000001';
  const waitForCliAction = (expected) =>
    app.evaluate(async (_, target) => {
      for (let i = 0; i < 250; i++) {
        if (JSON.stringify(globalThis.cliActions.at(-1)) === JSON.stringify(target)) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(
        `Missing CLI action: ${JSON.stringify(target)}; observed ${JSON.stringify(globalThis.cliActions)}`,
      );
    }, expected);
  await app.evaluate(({ shell }) => {
    globalThis.cliAlive = true;
    globalThis.cliActions = [];
    shell.openExternal = async (url) => {
      globalThis.cliActions.push(['desktop', url]);
    };
    const cp = process.getBuiltinModule('child_process');
    const original = cp.execFile;
    cp.execFile = (file, args, options, callback) => {
      if (file === '/bin/ps' && args.at(-1) === '4242') {
        if (globalThis.cliAlive)
          callback(null, '4242 ttys004 Thu Oct 1 04:52:11 2026 /opt/bin/codex', '');
        else callback(Object.assign(new Error('No process'), { code: 1 }), '', '');
      } else if (file === '/usr/bin/osascript') {
        globalThis.cliActions.push(['terminal', args[2]]);
        callback(null, args[2].startsWith('/dev/') ? 'shown' : 'resumed', '');
      } else return original(file, args, options, callback);
    };
  });
  mkdirSync(env.MONITOR_CODEX_HOOKS_DIR, { mode: 0o700 });
  const cliRecord = {
    version: 1,
    sessionId: cliId,
    terminal: {
      pid: 4242,
      tty: '/dev/ttys004',
      startedAt: 'Thu Oct 1 04:52:11 2026',
      at: Date.now(),
      ended: false,
    },
    activity: { event: 'UserPromptSubmit', turnId: 'cli-turn-123456', at: Date.now() },
  };
  const hookPath = join(env.MONITOR_CODEX_HOOKS_DIR, `${cliId}.json`);
  writeFileSync(hookPath, JSON.stringify(cliRecord), { mode: 0o600 });
  const cliDb = new DatabaseSync(join(home, 'state_5.sqlite'));
  cliDb.prepare("INSERT INTO threads VALUES(?,'CLI task','/work/cli','cli',0,?)").run(cliId, now);
  cliDb.close();
  await reopened.evaluate(() => window.monitor.refresh());
  const cliRow = reopened.getByTestId('group-row').filter({ hasText: 'CLI task' });
  await cliRow.getByTestId('open-task').click();
  assert.deepEqual(await app.evaluate(() => globalThis.cliActions), [
    ['desktop', `codex://threads/${cliId}`],
  ]);
  await cliRow.locator('.row-select').click();
  await reopened.getByRole('button', { name: 'Show in iTerm', exact: true }).click();
  await waitForCliAction(['terminal', '/dev/ttys004']);
  assert.deepEqual((await app.evaluate(() => globalThis.cliActions)).at(-1), [
    'terminal',
    '/dev/ttys004',
  ]);
  cliRecord.activity = { ...cliRecord.activity, event: 'Stop', at: Date.now() };
  cliRecord.completion = { ...cliRecord.activity, event: 'TurnComplete' };
  writeFileSync(hookPath, JSON.stringify(cliRecord));
  await app.evaluate(() => {
    globalThis.cliAlive = false;
  });
  await reopened.evaluate(() => window.monitor.refresh());
  await reopened.getByRole('button', { name: 'Resume in iTerm', exact: true }).click();
  await waitForCliAction(['terminal', `cd '/work/cli' && codex resume ${cliId}`]);
  assert.deepEqual((await app.evaluate(() => globalThis.cliActions)).at(-1), [
    'terminal',
    `cd '/work/cli' && codex resume ${cliId}`,
  ]);
  assert.equal(
    await reopened.getByRole('button', { name: 'Show in iTerm', exact: true }).count(),
    0,
  );
  await reopened.screenshot({ path: '.runtime/cli-smoke.png' });
  await reopened
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  assert.equal((await cliRow.getByTestId('open-task').innerText()).replace(/\s+/g, ' '), '');

  // A large backlog is indexed without flooding the queue or mounting every row.
  const oldCatalog = new DatabaseSync(join(home, 'state_5.sqlite'));
  const addOld = oldCatalog.prepare("INSERT INTO threads VALUES(?,?,?,'cli',0,?)");
  for (let i = 0; i < 260; i++)
    addOld.run(
      `history-${String(i).padStart(3, '0')}`,
      `Historical task ${i}`,
      join(homedir(), 'work/history'),
      now - 30 * 86400 - i,
    );
  oldCatalog.close();
  await reopened.evaluate(() => window.monitor.refresh());
  await reopened.waitForFunction(
    async () =>
      Object.keys((await window.monitor.snapshot()).state.sessions).filter((id) =>
        id.startsWith('codex:history-'),
      ).length === 260,
  );
  const librarySnapshot = await reopened.evaluate(() => window.monitor.snapshot());
  assert.equal(
    librarySnapshot.state.groups.filter(
      (g) => g.sessionIds[0].startsWith('codex:history-') && g.inQueue,
    ).length,
    0,
  );
  assert.equal(
    await reopened.getByTestId('group-row').filter({ hasText: 'Historical task' }).count(),
    0,
  );
  await reopened.getByRole('button', { name: /^Library / }).click();
  const history = reopened.getByTestId('library-project').filter({ hasText: '/work/history' });
  await history.waitFor();
  assert.equal(await history.getByTestId('library-row').count(), 20);
  await history.getByRole('button', { name: 'Show more · 240 remaining', exact: true }).click();
  assert.equal(await history.getByTestId('library-row').count(), 70);
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('Historical task 259');
  assert.equal(await reopened.getByTestId('library-row').count(), 1);
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('259 historiacl');
  assert.equal(await reopened.getByTestId('library-row').count(), 1);
  await reopened
    .getByRole('button', { name: 'Open in Codex: Historical task 259', exact: true })
    .click();
  assert.deepEqual((await app.evaluate(() => globalThis.cliActions)).at(-1), [
    'desktop',
    'codex://threads/history-259',
  ]);
  await reopened
    .getByRole('button', { name: 'Add Historical task 259 to queue', exact: true })
    .click();
  await reopened
    .getByTestId('library-row')
    .getByText(/In queue/)
    .waitFor();
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('');
  await reopened.screenshot({ path: '.runtime/library-smoke.png' });
  // Observed activity returns another historical task automatically.
  for (const client of clients)
    client.write(
      frame({
        type: 'broadcast',
        method: 'thread-stream-state-changed',
        version: 11,
        sourceClientId: 'fixture',
        params: {
          hostId: 'local',
          conversationId: 'history-000',
          change: {
            type: 'snapshot',
            revision: 2,
            conversationState: {
              id: 'history-000',
              threadRuntimeStatus: { type: 'active' },
              turns: [{ turnId: 'new-work', status: 'inProgress', turnStartedAtMs: Date.now() }],
            },
          },
        },
      }),
    );
  await reopened.waitForFunction(
    async () =>
      (await window.monitor.snapshot()).state.groups.find((g) =>
        g.sessionIds.includes('codex:history-000'),
      ).inQueue,
  );
  await reopened.getByRole('button', { name: /^Queue / }).click();
  await reopened
    .getByRole('region', { name: 'Running', exact: true })
    .getByTestId('group-row')
    .filter({ hasText: 'Historical task 0' })
    .waitFor();
  assert.equal(
    await reopened.getByRole('button', { name: 'Read', exact: true }).getAttribute('aria-expanded'),
    'true',
  );
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('Historical task 259');
  await reopened.getByTestId('group-row').filter({ hasText: 'Historical task 259' }).waitFor();
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('259 historiacl');
  await reopened.getByTestId('group-row').filter({ hasText: 'Historical task 259' }).waitFor();
  assert.equal(await reopened.getByTestId('group-row').count(), 1);
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('');
  await reopened.screenshot({ path: '.runtime/library-queue-smoke.png' });
  await reopened.getByRole('button', { name: /^Library / }).click();
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('Historical task 258');
  await reopened.getByTestId('library-row').locator('.row-select').click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(650, 480),
  );
  await reopened.waitForFunction(() => window.innerWidth === 650);
  assert.equal(
    await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await reopened.screenshot({ path: '.runtime/library-narrow-smoke.png' });
  // Source archive removes tasks from every view without losing Monitor organization.
  const beforeSourceArchive = (await reopened.evaluate(() => window.monitor.snapshot())).state;
  const archiveInCodex = (ids, archived) => {
    const catalog = new DatabaseSync(join(home, 'state_5.sqlite'));
    try {
      const update = catalog.prepare('UPDATE threads SET archived=? WHERE id=?');
      for (const id of ids) update.run(Number(archived), id);
    } finally {
      catalog.close();
    }
  };
  archiveInCodex(['history-258'], true);
  await reopened.evaluate(() => window.monitor.refresh());
  await reopened
    .getByText('This task is no longer available in Monitor.', { exact: true })
    .waitFor();
  await reopened.getByRole('button', { name: '← Back to Library', exact: true }).click();
  assert.equal(await reopened.getByTestId('library-row').count(), 0);
  archiveInCodex(['dddddd'], true);
  await reopened.evaluate(() => window.monitor.refresh());
  await reopened.getByRole('button', { name: /^Queue / }).click();
  await reopened
    .getByTestId('group-row')
    .filter({ hasText: 'A newly created task' })
    .waitFor({ state: 'hidden' });
  archiveInCodex(['bbbbbb'], true);
  await reopened.evaluate(() => window.monitor.refresh());
  await reopened.getByRole('button', { name: /^Archived / }).click();
  const billingArchive = reopened.getByTestId('archive-row').filter({ hasText: 'Billing rollout' });
  await billingArchive.getByText('1 task', { exact: true }).waitFor();
  await billingArchive.locator('.row-select').click();
  await reopened
    .getByRole('main', { name: 'Task view' })
    .getByRole('heading', { name: 'Build the billing rollout', exact: true })
    .waitFor();
  await reopened
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Billing rollout', exact: true })
    .click();
  await reopened.waitForFunction(
    () => document.querySelectorAll('[data-testid="session-card"]').length === 1,
  );
  assert.ok(
    (await reopened.getByTestId('session-card').innerText()).includes('Build the billing rollout'),
  );
  archiveInCodex(['aaaaaa'], true);
  await reopened.evaluate(() => window.monitor.refresh());
  await billingArchive.waitFor({ state: 'hidden' });
  await reopened
    .getByRole('complementary', { name: 'Workstream details' })
    .waitFor({ state: 'hidden' });
  const hiddenIds = ['aaaaaa', 'bbbbbb', 'dddddd', 'history-258'];
  const hiddenState = (await reopened.evaluate(() => window.monitor.snapshot())).state;
  for (const id of hiddenIds) {
    assert.equal(hiddenState.sessions[`codex:${id}`], undefined);
    assert.ok(!hiddenState.groups.some((g) => g.sessionIds.includes(`codex:${id}`)));
  }
  for (const destination of [/^Library /, /^Archived /]) {
    await reopened.getByRole('button', { name: destination }).click();
    for (const query of [
      'Billing rollout',
      'Review the billing changes',
      'A newly created task',
      'Historical task 258',
    ]) {
      await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill(query);
      await reopened.getByRole('heading', { name: 'No matching workstreams' }).waitFor();
    }
  }
  await reopened.getByRole('textbox', { name: 'Filter workstreams' }).fill('');
  // Also archive a cached task while Monitor is closed: the first source read must catch it.
  await app.close();
  app = undefined;
  archiveInCodex(['cccccc'], true);
  app = await electron.launch({ args: ['.'], env });
  const afterArchiveRestart = await app.firstWindow();
  await afterArchiveRestart.getByRole('heading', { name: 'Your queue.' }).waitFor();
  const restartState = (await afterArchiveRestart.evaluate(() => window.monitor.snapshot())).state;
  assert.equal(restartState.sessions['codex:cccccc'], undefined);
  assert.ok(!restartState.groups.some((g) => g.archived));
  archiveInCodex([...hiddenIds, 'cccccc'], false);
  await afterArchiveRestart.evaluate(() => window.monitor.refresh());
  const unarchivedState = (await afterArchiveRestart.evaluate(() => window.monitor.snapshot()))
    .state;
  assert.deepEqual(unarchivedState.groups, beforeSourceArchive.groups);
  await afterArchiveRestart.getByRole('button', { name: /^Archived / }).click();
  await afterArchiveRestart
    .getByTestId('archive-row')
    .filter({ hasText: 'Billing rollout' })
    .locator('.row-select')
    .click();
  assert.equal(await afterArchiveRestart.getByTestId('session-card').count(), 2);
  assert.deepEqual(errors, []);

  // Fork families cross organization boundaries. Exercise source metadata through
  // the real adapters, group commands, task navigation, and restart persistence.
  afterArchiveRestart.on('pageerror', (error) => errors.push(String(error)));
  await app.evaluate(({ shell }) => {
    globalThis.forkOpened = [];
    shell.openExternal = async (url) => {
      globalThis.forkOpened.push(url);
    };
  });
  const forkTasks = [
    ['fork-root0', 'Investigate latency', null],
    ['fork-cache', 'Try caching', 'fork-root0'],
    ['fork-inval', 'Investigate invalidation', 'fork-cache'],
    ['fork-stale', 'Reproduce stale reads', 'fork-inval'],
    ['fork-ttl00', 'Try bounded TTL', 'fork-inval'],
    ['fork-bench', 'Benchmark alternative', 'fork-cache'],
    ['fork-query', 'Explore query changes', 'fork-root0'],
    ['fork-index', 'Test covering index', 'fork-query'],
    ['solo-task0', 'Standalone task', null],
  ];
  const forkDb = new DatabaseSync(join(home, 'state_5.sqlite'));
  forkDb.exec(
    'ALTER TABLE threads ADD COLUMN created_at INTEGER; ALTER TABLE threads ADD COLUMN rollout_path TEXT',
  );
  for (const [index, [id, title, parent]] of forkTasks.entries()) {
    const path = join(home, `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          forked_from_id: parent,
          base_instructions: { text: 'SYNTHETIC PRIVATE INSTRUCTIONS' },
        },
      }) + '\n',
    );
    forkDb
      .prepare(
        "INSERT INTO threads(id,title,cwd,source,archived,updated_at,created_at,rollout_path) VALUES(?,?,?,'cli',0,?,?,?)",
      )
      .run(id, title, '/work/api-service', now, now - 3600 + index * 60, path);
  }
  forkDb.close();
  await afterArchiveRestart.evaluate(() => window.monitor.refresh());
  await afterArchiveRestart.waitForFunction(
    async () =>
      (await window.monitor.snapshot()).state.sessions['codex:fork-stale']?.status === 'running',
  );
  const forkGroups = await afterArchiveRestart.evaluate(async () => {
    let snapshot = await window.monitor.snapshot();
    const groupFor = (id) =>
      snapshot.state.groups.find((g) => g.sessionIds.includes(`codex:${id}`)).id;
    const groups = {
      performance: groupFor('fork-root0'),
      correctness: groupFor('fork-inval'),
      experiments: groupFor('fork-ttl00'),
      database: groupFor('fork-query'),
    };
    for (const [key, name] of [
      ['performance', 'Performance'],
      ['correctness', 'Correctness'],
      ['experiments', 'Experiments'],
      ['database', 'Database'],
    ])
      snapshot = await window.monitor.command({
        type: 'rename',
        groupId: groups[key],
        name,
        projectOverride: null,
      });
    for (const [id, target] of [
      ['fork-cache', 'performance'],
      ['fork-bench', 'performance'],
      ['fork-stale', 'correctness'],
      ['fork-index', 'database'],
    ])
      snapshot = await window.monitor.command({
        type: 'assign',
        sessionId: `codex:${id}`,
        targetId: groups[target],
      });
    await window.monitor.command({ type: 'archive', groupId: groups.experiments });
    return groups;
  });
  await afterArchiveRestart.getByRole('button', { name: /^Queue / }).click();
  const standaloneRow = afterArchiveRestart
    .getByTestId('group-row')
    .filter({ hasText: 'Standalone task' });
  assert.equal(await standaloneRow.getByRole('button', { name: /^View fork family:/ }).count(), 0);
  await afterArchiveRestart
    .getByRole('button', { name: 'View task: Standalone task', exact: true })
    .click();
  const standaloneView = afterArchiveRestart.getByRole('main', { name: 'Task view' });
  await standaloneView.getByRole('heading', { name: 'Standalone task', exact: true }).waitFor();
  assert.equal(await standaloneView.getByRole('navigation', { name: 'Task sections' }).count(), 0);
  assert.equal(await standaloneView.getByTestId('fork-row').count(), 0);
  await standaloneView.getByText('No parent recorded', { exact: true }).waitFor();
  await standaloneView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  // A group-row shortcut opens the attention-prioritized family immediately.
  const performanceRow = afterArchiveRestart
    .getByTestId('group-row')
    .filter({ hasText: 'Performance' });
  await performanceRow
    .getByRole('button', { name: 'View fork family: Benchmark alternative', exact: true })
    .click();
  const shortcutView = afterArchiveRestart.getByRole('main', { name: 'Task view' });
  await shortcutView.getByRole('heading', { name: 'Benchmark alternative', exact: true }).waitFor();
  assert.equal(await shortcutView.getByTestId('fork-row').count(), 8);
  assert.equal(
    await shortcutView
      .getByRole('button', { name: 'Fork family 8', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await shortcutView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  await afterArchiveRestart
    .getByTestId('group-row')
    .filter({ hasText: 'Performance' })
    .locator('.row-select')
    .click();
  // A card has separate details and family actions; the family shortcut needs one click.
  await afterArchiveRestart
    .getByTestId('session-card')
    .filter({ hasText: 'Try caching' })
    .getByRole('button', { name: 'View fork family: Try caching', exact: true })
    .click();
  await shortcutView.getByRole('heading', { name: 'Try caching', exact: true }).waitFor();
  assert.equal(await shortcutView.getByTestId('fork-row').count(), 8);
  await shortcutView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  await afterArchiveRestart
    .getByRole('button', { name: 'View task: Try caching', exact: true })
    .click();
  const taskView = afterArchiveRestart.getByRole('main', { name: 'Task view' });
  await taskView.getByRole('heading', { name: 'Try caching', exact: true }).waitFor();
  assert.equal(await taskView.getByTestId('fork-row').count(), 0);
  await taskView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Performance', exact: true })
    .waitFor();
  const groupTasks = taskView.getByRole('region', { name: 'Tasks in this group' });
  assert.equal(await groupTasks.getByRole('button', { name: /^View task:/ }).count(), 3);
  await groupTasks
    .getByRole('button', { name: 'View task: Benchmark alternative', exact: true })
    .click();
  await taskView.getByRole('heading', { name: 'Benchmark alternative', exact: true }).waitFor();
  await groupTasks.getByRole('button', { name: 'View task: Try caching', exact: true }).click();
  // Return to the selected group without losing the queue search or group context.
  await taskView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Queue', exact: true })
    .click();
  assert.equal(await afterArchiveRestart.getByTestId('session-card').count(), 3);
  await afterArchiveRestart
    .getByTestId('session-card')
    .filter({ hasText: 'Try caching' })
    .getByText('View task details', { exact: false })
    .click();
  await taskView.getByRole('button', { name: 'Fork family 8', exact: true }).click();
  assert.equal(await taskView.getByTestId('fork-row').count(), 8);
  await taskView.getByText('8 tasks across 4 groups', { exact: true }).waitFor();
  await taskView.getByText('Experiments · Archived in Monitor', { exact: true }).waitFor();
  const rowOrder = await taskView
    .getByTestId('fork-row')
    .evaluateAll((rows) => rows.map((row) => row.dataset.forkId));
  await taskView
    .getByRole('button', { name: 'View task: Investigate invalidation', exact: true })
    .click();
  assert.equal(await taskView.getByTestId('task-group-name').innerText(), 'Correctness');
  assert.deepEqual(
    await taskView
      .getByTestId('fork-row')
      .evaluateAll((rows) => rows.map((row) => row.dataset.forkId)),
    rowOrder,
  );
  await taskView.getByRole('button', { name: 'Open in Codex ↗', exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.forkOpened), ['codex://threads/fork-inval']);
  await taskView.getByRole('button', { name: 'Focus branch', exact: true }).click();
  assert.equal(await taskView.getByTestId('fork-row').count(), 5);
  await taskView
    .getByRole('button', { name: 'Collapse forks of Investigate invalidation', exact: true })
    .click();
  assert.equal(await taskView.getByTestId('fork-row').count(), 3);
  await taskView.getByText('2 hidden · 1 need review · 1 running', { exact: true }).waitFor();
  await taskView.getByRole('button', { name: 'Expand all', exact: true }).click();
  await taskView.getByRole('button', { name: 'Focus branch', exact: true }).click();
  await taskView.getByRole('button', { name: '↗ Expand view', exact: true }).click();
  assert.equal(await taskView.getByRole('complementary', { name: 'Task details' }).count(), 0);
  await taskView.getByRole('button', { name: '↙ Show details', exact: true }).click();
  await taskView.getByRole('button', { name: 'Try caching ↗', exact: true }).click();
  await taskView.getByRole('heading', { name: 'Try caching', exact: true }).waitFor();
  await taskView.getByRole('button', { name: 'Investigate invalidation ↗', exact: true }).click();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1120, 960));
  await afterArchiveRestart.screenshot({ path: '.runtime/fork-task-smoke.png' });
  await taskView.getByRole('button', { name: 'Details', exact: true }).click();
  assert.equal(await taskView.getByTestId('fork-row').count(), 0);
  await afterArchiveRestart.screenshot({ path: '.runtime/task-details-smoke.png' });
  const beforeAssignment = (await afterArchiveRestart.evaluate(() => window.monitor.snapshot()))
    .state;
  assert.equal(await taskView.getByRole('combobox').count(), 0);
  const changeGroup = taskView.getByRole('button', { name: 'Change group', exact: true });
  await changeGroup.click();
  const groupPicker = afterArchiveRestart.getByRole('dialog', {
    name: 'Change group',
    exact: true,
  });
  const groupSearch = groupPicker.getByRole('searchbox', { name: 'Search groups', exact: true });
  await groupSearch.waitFor();
  assert.equal(await groupSearch.evaluate((element) => document.activeElement === element), true);
  const expectedRecentGroups = beforeAssignment.groups
    .filter((g) => g.id !== forkGroups.correctness)
    .map((g) => ({
      id: g.id,
      activity: Math.max(
        0,
        ...g.sessionIds.map((id) => {
          const s = beforeAssignment.sessions[id];
          return !s || (s.provider === 'codex' && s.archived) ? 0 : (s.activityAt ?? s.updatedAt);
        }),
      ),
    }))
    .filter((g) => g.activity > 0)
    .sort((a, b) => b.activity - a.activity || a.id.localeCompare(b.id))
    .slice(0, 6)
    .map((g) => g.id);
  assert.deepEqual(
    await groupPicker
      .getByTestId('group-choice')
      .evaluateAll((buttons) => buttons.map((b) => b.dataset.groupId)),
    expectedRecentGroups,
  );
  await afterArchiveRestart.screenshot({ path: '.runtime/group-picker-recent-smoke.png' });
  // The search covers the full catalog, including destinations outside the six recent groups.
  await groupSearch.fill('Historical task 259');
  await groupPicker
    .getByRole('button', { name: 'Move to Historical task 259', exact: true })
    .waitFor();
  await groupSearch.fill('Experiments');
  await groupPicker
    .getByRole('button', { name: 'Move to Experiments', exact: true })
    .getByText(/Archived in Monitor/)
    .waitFor();
  await groupSearch.fill('Correctness');
  await groupPicker.getByText('No groups match your search.', { exact: true }).waitFor();
  await groupSearch.fill('nonexistent destination');
  await groupPicker.getByText('No groups match your search.', { exact: true }).waitFor();
  await groupSearch.press('Escape');
  await groupPicker.waitFor({ state: 'hidden' });
  assert.equal(await changeGroup.evaluate((element) => document.activeElement === element), true);
  assert.deepEqual(
    (await afterArchiveRestart.evaluate(() => window.monitor.snapshot())).state.groups,
    beforeAssignment.groups,
  );
  await changeGroup.click();
  await groupSearch.fill('perfromance');
  const performanceDestination = groupPicker.getByRole('button', {
    name: 'Move to Performance',
    exact: true,
  });
  await performanceDestination.waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(780, 600));
  assert.equal(
    await groupPicker.evaluate(
      (element) =>
        element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight,
    ),
    true,
  );
  await afterArchiveRestart.screenshot({ path: '.runtime/group-picker-search-smoke.png' });
  await groupSearch.press('ArrowDown');
  assert.equal(
    await performanceDestination.evaluate((element) => document.activeElement === element),
    true,
  );
  await performanceDestination.press('Enter');
  await groupPicker.waitFor({ state: 'hidden' });
  assert.equal(await changeGroup.evaluate((element) => document.activeElement === element), true);
  assert.equal(await taskView.getByTestId('task-group-name').innerText(), 'Performance');
  await taskView
    .getByRole('status')
    .getByText('Moved to Performance. Fork ancestry is preserved.', { exact: true })
    .waitFor();
  const afterAssignment = (await afterArchiveRestart.evaluate(() => window.monitor.snapshot()))
    .state;
  assert.deepEqual(
    afterAssignment.groups.map((g) => g.id),
    beforeAssignment.groups.map((g) => g.id),
  );
  assert.deepEqual(afterAssignment.sessions['codex:fork-inval'].lineage, {
    parentId: 'codex:fork-cache',
  });
  assert.deepEqual(afterAssignment.groups.find((g) => g.id === forkGroups.correctness).sessionIds, [
    'codex:fork-stale',
  ]);
  assert.equal(await taskView.getByTestId('fork-row').count(), 0);
  await taskView.getByRole('button', { name: 'Fork family 8', exact: true }).click();
  assert.equal(await taskView.getByTestId('fork-row').count(), 8);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(780, 900));
  assert.equal(
    await taskView.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );
  await afterArchiveRestart.screenshot({ path: '.runtime/fork-task-narrow-smoke.png' });
  await taskView.getByRole('button', { name: 'Details', exact: true }).click();
  assert.equal(
    await taskView.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
  );
  await afterArchiveRestart.screenshot({ path: '.runtime/task-details-narrow-smoke.png' });
  await taskView.getByRole('button', { name: 'Fork family 8', exact: true }).click();
  archiveInCodex(['fork-root0'], true);
  await afterArchiveRestart.evaluate(() => window.monitor.refresh());
  await taskView.getByText('Parent task unavailable', { exact: true }).waitFor();
  assert.equal(await taskView.getByText('Investigate latency', { exact: true }).count(), 0);
  archiveInCodex(['fork-root0'], false);
  await afterArchiveRestart.evaluate(() => window.monitor.refresh());
  // The task view also opens from Library and Monitor's archive.
  await afterArchiveRestart.getByRole('button', { name: /^Archived / }).click();
  await afterArchiveRestart
    .getByRole('button', { name: 'View fork family: Try bounded TTL', exact: true })
    .click();
  await taskView.getByRole('heading', { name: 'Try bounded TTL', exact: true }).waitFor();
  assert.equal(await taskView.getByTestId('fork-row').count(), 8);
  await taskView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Archived', exact: true })
    .click();
  await afterArchiveRestart
    .getByRole('button', { name: 'View task: Try bounded TTL · Experiments', exact: true })
    .click();
  await afterArchiveRestart
    .getByRole('main', { name: 'Task view' })
    .getByRole('heading', { name: 'Try bounded TTL', exact: true })
    .waitFor();
  await afterArchiveRestart.getByRole('button', { name: /^Library / }).click();
  await afterArchiveRestart
    .getByRole('textbox', { name: 'Filter workstreams' })
    .fill('Correctness');
  const libraryShortcut = afterArchiveRestart.getByRole('button', {
    name: 'View fork family: Reproduce stale reads',
    exact: true,
  });
  await libraryShortcut.focus();
  await libraryShortcut.press('Enter');
  await taskView.getByRole('heading', { name: 'Reproduce stale reads', exact: true }).waitFor();
  assert.equal(await taskView.getByTestId('fork-row').count(), 8);
  await taskView
    .getByRole('navigation', { name: 'Task breadcrumbs' })
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  await afterArchiveRestart
    .getByRole('button', { name: 'View task: Reproduce stale reads · Correctness', exact: true })
    .click();
  await afterArchiveRestart
    .getByRole('main', { name: 'Task view' })
    .getByRole('heading', { name: 'Reproduce stale reads', exact: true })
    .waitFor();
  await app.close();
  app = undefined;
  app = await electron.launch({ args: ['.'], env });
  const afterForkRestart = await app.firstWindow();
  await afterForkRestart.getByRole('heading', { name: 'Your queue.' }).waitFor();
  const savedForks = (await afterForkRestart.evaluate(() => window.monitor.snapshot())).state;
  assert.ok(
    savedForks.groups
      .find((g) => g.id === forkGroups.performance)
      .sessionIds.includes('codex:fork-inval'),
  );
  assert.equal(savedForks.groups.find((g) => g.id === forkGroups.experiments).archived, true);
  assert.deepEqual(savedForks.sessions['codex:fork-inval'].lineage, {
    parentId: 'codex:fork-cache',
  });
  assert.doesNotMatch(JSON.stringify(savedForks), /SYNTHETIC PRIVATE INSTRUCTIONS/);
  assert.deepEqual(errors, []);
  console.log(
    'Electron smoke passed: static task group names, recent/search group picker, cancel/focus return, keyboard reassignment and persistence, conditional fork-family shortcuts, details-first navigation, sibling tasks, breadcrumbs, focus/collapse/expansion, missing parents, responsive layout, source metadata privacy, search, source archives, Library pagination, CLI actions, grouping, priority, and notifications.',
  );
} finally {
  await app?.close();
  for (const client of clients) client.destroy();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
