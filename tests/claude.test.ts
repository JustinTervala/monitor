import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readDesktopRecords, readLiveProcesses } from '../src/providers/claude/catalog';
import { ClaudeProvider } from '../src/providers/claude';
import { MonitorService, type NotificationEvent } from '../src/main/service';
import { MonitorStore } from '../src/main/store';
import type { ProviderHealth, Session } from '../src/shared/types';

const A = 'local_aaaaaaaa-0000-4000-8000-000000000001';
const B = 'local_bbbbbbbb-0000-4000-8000-000000000002';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'monitor-claude-'));
  const desktop = join(root, 'desktop'),
    org = join(desktop, 'account', 'org'),
    config = join(root, 'config');
  mkdirSync(org, { recursive: true });
  mkdirSync(join(config, 'sessions'), { recursive: true });
  const record = (id: string, fields: Record<string, unknown>) =>
    writeFileSync(
      join(org, `${id}.json`),
      JSON.stringify({
        sessionId: id,
        cliSessionId: id.slice(6),
        cwd: '/work/payments',
        title: 'Ship billing',
        isArchived: false,
        createdAt: 1000,
        lastActivityAt: 2000,
        // Content that must never reach Monitor.
        initialMessage: 'SECRET PROMPT',
        postTurnSummary: 'SECRET RESPONSE',
        ...fields,
      }),
    );
  const proc = (pid: number, fields: Record<string, unknown>) =>
    writeFileSync(
      join(config, 'sessions', `${pid}.json`),
      JSON.stringify({ pid, entrypoint: 'claude-desktop', ...fields }),
    );
  return { root, desktop, org, config, record, proc };
}

test('catalog reads whitelisted desktop metadata only and never writes the source', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  f.record(A, { lastAssistantUuid: uuid(1), error: 'SECRET ERROR', errorAt: 1500 });
  f.record(B, { isArchived: true });
  writeFileSync(join(f.org, 'scheduled-tasks.json'), '{}');
  writeFileSync(join(f.org, 'local_broken.json'), '{not json');
  const before = readFileSync(join(f.org, `${A}.json`));
  const records = readDesktopRecords(f.desktop);
  assert.equal(records.length, 2);
  const a = records.find((r) => r.sessionId === A)!;
  assert.equal(a.lastAssistantUuid, uuid(1));
  assert.equal(a.errorAt, 1500);
  assert.doesNotMatch(JSON.stringify(records), /SECRET/);
  assert.deepEqual(readFileSync(join(f.org, `${A}.json`)), before);
});

test('registry ignores dead, malformed and unrelated processes', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  f.proc(11, { hostSessionId: A, status: 'busy', statusUpdatedAt: 5 });
  f.proc(12, { hostSessionId: A, status: 'idle', statusUpdatedAt: 9 });
  f.proc(13, { hostSessionId: B, status: 'waiting', waitingFor: 'permission prompt' });
  f.proc(14, { hostSessionId: 'not-a-desktop-id', status: 'busy' });
  f.proc(15, { status: 'busy' });
  writeFileSync(join(f.config, 'sessions', '16.json'), JSON.stringify({ pid: 99 }));
  const live = readLiveProcesses(join(f.config, 'sessions'), (pid) => pid !== 13);
  assert.deepEqual([...live.keys()], [A]);
  assert.equal(live.get(A)!.status, 'idle');
});

test('a task moves through running, review, acknowledgment, disconnect and reconnect', async (t) => {
  const f = fixture();
  let running = true;
  const provider = new ClaudeProvider({
    desktopDir: f.desktop,
    configDir: f.config,
    desktopRunning: async () => running,
    processAlive: () => true,
    pollMs: 60_000,
  });
  const store = mkdtempSync(join(tmpdir(), 'monitor-claude-store-'));
  const notices: NotificationEvent[] = [];
  const health: ProviderHealth[] = [];
  const service = new MonitorService(new MonitorStore(join(store, 's.sqlite')), [provider], (n) =>
    notices.push(n),
  );
  service.on('snapshot', (s) => health.push(...s.health));
  t.after(() => {
    service.stop();
    rmSync(f.root, { recursive: true });
    rmSync(store, { recursive: true });
  });
  const current = async (): Promise<Session> => {
    await provider.refresh();
    return service.snapshot().state.sessions[`claude:${A}`];
  };
  // Historical result on startup: baseline only, no notification.
  f.record(A, { lastAssistantUuid: uuid(1), lastActivityAt: 2000, lastFocusedAt: 1500 });
  await service.start();
  let s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, `result:${uuid(1)}`);
  assert.equal(s.evidence, 'live');
  assert.equal(notices.length, 0);

  f.proc(42, { hostSessionId: A, status: 'busy', statusUpdatedAt: 3000 });
  s = await current();
  assert.equal(s.status, 'running');
  assert.equal(notices.length, 0);

  f.proc(42, {
    hostSessionId: A,
    status: 'waiting',
    waitingFor: 'permission prompt',
    statusUpdatedAt: 3100,
  });
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.detail, 'Waiting for approval in Claude');
  assert.equal(notices.length, 1);
  await current();
  assert.equal(notices.length, 1, 'a repeated observation of the same request is quiet');

  f.proc(42, { hostSessionId: A, status: 'busy', statusUpdatedAt: 3200 });
  assert.equal((await current()).status, 'running');
  f.proc(42, { hostSessionId: A, status: 'idle', statusUpdatedAt: 4000 });
  f.record(A, { lastAssistantUuid: uuid(2), lastActivityAt: 4000, lastFocusedAt: 1500 });
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, `result:${uuid(2)}`);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].body, 'Claude · New response · not opened in Claude since');

  // Focusing the session in Claude acknowledges it; the result identity is unchanged.
  f.record(A, { lastAssistantUuid: uuid(2), lastActivityAt: 4000, lastFocusedAt: 4100 });
  s = await current();
  assert.equal(s.status, 'read');
  assert.equal(s.attentionKey, `result:${uuid(2)}`);
  assert.equal(notices.length, 2);

  // Desktop quits: unavailable, never "finished".
  running = false;
  s = await current();
  assert.equal(s.status, 'unknown');
  assert.equal(s.evidence, 'unavailable');
  assert.equal(s.attentionKey, null);
  // Result that landed while offline is a new baseline on reconnect, not a notification.
  f.record(A, { lastAssistantUuid: uuid(3), lastActivityAt: 5000, lastFocusedAt: 4100 });
  running = true;
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, `result:${uuid(3)}`);
  assert.equal(notices.length, 2);
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(health.some((h) => h.provider === 'claude' && h.state === 'live'));
});

test('an error is actionable until the session is focused afterwards', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  let sessions: Session[] = [];
  const provider = new ClaudeProvider({
    desktopDir: f.desktop,
    configDir: f.config,
    desktopRunning: async () => true,
    pollMs: 60_000,
  });
  t.after(() => provider.stop());
  f.record(A, { lastAssistantUuid: uuid(1), error: 'x', errorAt: 3000, lastFocusedAt: 2500 });
  await provider.start({ sessions: (v) => (sessions = v), health: () => {} });
  assert.equal(sessions[0].status, 'review');
  assert.equal(sessions[0].attentionKey, 'error:3000');
  f.record(A, { lastAssistantUuid: uuid(1), error: 'x', errorAt: 3000, lastFocusedAt: 3500 });
  await provider.refresh();
  assert.equal(sessions[0].status, 'read');
});

test('archived source tasks are discovered only when already followed', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  let sessions: Session[] = [];
  const provider = new ClaudeProvider({
    desktopDir: f.desktop,
    configDir: f.config,
    desktopRunning: async () => true,
    pollMs: 60_000,
  });
  t.after(() => provider.stop());
  f.record(A, {});
  f.record(B, { isArchived: true });
  await provider.start({ sessions: (v) => (sessions = v), health: () => {} });
  assert.deepEqual(
    sessions.map((s) => s.externalId),
    [A],
  );
  assert.equal(sessions[0].status, 'unknown', 'a session without a turn has no result identity');
  provider.track([A, B]);
  await provider.refresh();
  assert.equal(sessions.find((s) => s.externalId === B)?.archived, true);
});

test('session URLs use the desktop exact-session route and reject anything else', () => {
  const provider = new ClaudeProvider({ desktopDir: '/nonexistent' });
  assert.equal(provider.sessionUrl(A), `claude://code/continue?session=${A}`);
  for (const bad of ['last', 'local_../x', 'cse_abc', 'local_a&session=b', `${A}\n`])
    assert.throws(() => provider.sessionUrl(bad));
});
