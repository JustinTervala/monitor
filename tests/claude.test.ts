import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readDesktopRecords,
  readHookSessions,
  readLiveProcesses,
} from '../src/providers/claude/catalog';
import { resumeCommand } from '../src/shared/resume';
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
    config = join(root, 'config'),
    hooks = join(root, 'hooks');
  mkdirSync(org, { recursive: true });
  mkdirSync(hooks);
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
  // Mirrors what plugins/monitor-hooks/hooks/record.sh writes.
  const hook = (
    session: string,
    kind: 'start' | 'result' | 'end',
    fields: Record<string, string>,
  ) =>
    writeFileSync(
      join(hooks, `${session}.${kind}`),
      Object.entries({ v: '1', entrypoint: 'cli', cwd: '/work/cli', ...fields })
        .map(([k, v]) => `${k}=${v}`)
        .join('\n') + '\n',
    );
  return { root, desktop, org, config, hooks, record, proc, hook };
}

test('catalog reads whitelisted desktop metadata only and never writes the source', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  f.record(A, {
    lastAssistantUuid: uuid(1),
    completedTurns: 1,
    error: 'SECRET ERROR',
    errorAt: 1500,
  });
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
  // Terminal processes: interactive CLI only, never headless (-p) runs.
  f.proc(17, {
    entrypoint: 'cli',
    kind: 'interactive',
    sessionId: uuid(7),
    status: 'busy',
    cwd: '/t',
  });
  f.proc(18, { entrypoint: 'sdk-cli', kind: 'interactive', sessionId: uuid(8), status: 'busy' });
  const live = readLiveProcesses(join(f.config, 'sessions'), (pid) => pid !== 13);
  assert.deepEqual([...live.desktop.keys()], [A]);
  assert.equal(live.desktop.get(A)!.status, 'idle');
  assert.deepEqual([...live.terminal.keys()], [uuid(7)]);
  assert.equal(live.terminal.get(uuid(7))!.cwd, '/t');
});

test('a task moves through running, review, acknowledgment, disconnect and reconnect', async (t) => {
  const f = fixture();
  let running = true;
  const provider = new ClaudeProvider({
    desktopDir: f.desktop,
    configDir: f.config,
    hooksDir: f.hooks,
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
  f.record(A, {
    lastAssistantUuid: uuid(1),
    completedTurns: 1,
    lastActivityAt: 2000,
    lastFocusedAt: 1500,
  });
  await service.start();
  let s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, `result:1`);
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
  f.record(A, {
    lastAssistantUuid: uuid(2),
    completedTurns: 2,
    lastActivityAt: 4000,
    lastFocusedAt: 1500,
  });
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, `result:2`);
  assert.equal(notices.length, 2);
  assert.equal(notices[1].body, 'Claude · New response · not opened in Claude since');
  // Observed live: the desktop saves the record again with the final message's
  // uuid moments after the turn ends. That is the same result, not a new one.
  f.record(A, {
    lastAssistantUuid: uuid(9),
    completedTurns: 2,
    lastActivityAt: 4050,
    lastFocusedAt: 1500,
  });
  assert.equal((await current()).attentionKey, 'result:2');
  assert.equal(notices.length, 2);

  // Focusing the session in Claude acknowledges it; the result identity is unchanged.
  f.record(A, {
    lastAssistantUuid: uuid(2),
    completedTurns: 2,
    lastActivityAt: 4050,
    lastFocusedAt: 4100,
  });
  s = await current();
  assert.equal(s.status, 'read');
  assert.equal(s.attentionKey, `result:2`);
  assert.equal(notices.length, 2);

  // Desktop quits: unavailable, never "finished".
  running = false;
  s = await current();
  assert.equal(s.status, 'unknown');
  assert.equal(s.evidence, 'unavailable');
  assert.equal(s.attentionKey, null);
  // Result that landed while offline is a new baseline on reconnect, not a notification.
  f.record(A, {
    lastAssistantUuid: uuid(3),
    completedTurns: 3,
    lastActivityAt: 5000,
    lastFocusedAt: 4100,
  });
  running = true;
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, `result:3`);
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
    hooksDir: f.hooks,
    desktopRunning: async () => true,
    pollMs: 60_000,
  });
  t.after(() => provider.stop());
  f.record(A, {
    lastAssistantUuid: uuid(1),
    completedTurns: 1,
    error: 'x',
    errorAt: 3000,
    lastFocusedAt: 2500,
  });
  await provider.start({ sessions: (v) => (sessions = v), health: () => {} });
  assert.equal(sessions[0].status, 'review');
  assert.equal(sessions[0].attentionKey, 'error:3000');
  f.record(A, {
    lastAssistantUuid: uuid(1),
    completedTurns: 1,
    error: 'x',
    errorAt: 3000,
    lastFocusedAt: 3500,
  });
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
    hooksDir: f.hooks,
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

test('hook files are parsed defensively', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  f.hook(uuid(1), 'start', { at: '1000', title: 'Fix login bug' });
  f.hook(uuid(1), 'result', { at: '2000', kind: 'stop', prompt: 'p-1' });
  f.hook(uuid(2), 'result', { at: '3000', kind: 'error', error: 'rate_limit', prompt: '' });
  writeFileSync(join(f.hooks, `${uuid(3)}.result`), 'v=2\nat=1\n');
  writeFileSync(join(f.hooks, '../escape.result'), 'v=1\nat=1\n');
  writeFileSync(join(f.hooks, 'not-a-session.result'), 'v=1\nat=1\n');
  const hooks = readHookSessions(f.hooks);
  assert.deepEqual([...hooks.keys()].sort(), [uuid(1), uuid(2)]);
  assert.equal(hooks.get(uuid(1))!.title, 'Fix login bug');
  assert.equal(hooks.get(uuid(1))!.result!.key, 'result:p-1');
  assert.equal(hooks.get(uuid(2))!.result!.key, 'error:3000');
});

test('terminal sessions: running, result, exit and resume command', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  let sessions: Session[] = [];
  const health: ProviderHealth[] = [];
  const provider = new ClaudeProvider({
    desktopDir: f.desktop,
    configDir: f.config,
    hooksDir: f.hooks,
    desktopRunning: async () => false,
    processAlive: () => true,
    pollMs: 60_000,
  });
  t.after(() => provider.stop());
  const id = `cli_${uuid(5)}`;
  const current = async () => {
    await provider.refresh();
    return sessions.find((s) => s.externalId === id)!;
  };
  // Desktop sessions resumed in a terminal stay one desktop task, not a duplicate.
  f.record(A, { lastAssistantUuid: uuid(1), completedTurns: 1 });
  f.proc(21, { entrypoint: 'cli', kind: 'interactive', sessionId: A.slice(6), status: 'busy' });
  f.hook(uuid(5), 'start', { at: '1000', title: 'Refactor parser' });
  f.proc(20, {
    entrypoint: 'cli',
    kind: 'interactive',
    sessionId: uuid(5),
    status: 'busy',
    statusUpdatedAt: 1100,
  });
  await provider.start({ sessions: (v) => (sessions = v), health: (h) => health.push(h) });
  let s = await current();
  assert.equal(sessions.length, 2);
  assert.equal(s.status, 'running');
  assert.equal(s.evidence, 'live', 'terminal sessions are observed without the desktop');
  assert.equal(s.openable, false);
  assert.equal(s.title, 'Refactor parser');
  assert.equal(health.at(-1)!.state, 'degraded');
  assert.throws(() => provider.sessionUrl(id), /resume command/);
  assert.equal(resumeCommand(s), `cd '/work/cli' && claude --resume ${uuid(5)}`);

  f.proc(20, {
    entrypoint: 'cli',
    kind: 'interactive',
    sessionId: uuid(5),
    status: 'waiting',
    waitingFor: 'permission prompt',
    statusUpdatedAt: 1200,
  });
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, 'waiting:1200');

  f.proc(20, {
    entrypoint: 'cli',
    kind: 'interactive',
    sessionId: uuid(5),
    status: 'idle',
    statusUpdatedAt: 2000,
  });
  f.hook(uuid(5), 'result', { at: '2000', kind: 'stop', prompt: 'turn-1' });
  s = await current();
  assert.equal(s.status, 'review');
  assert.equal(s.attentionKey, 'result:turn-1');
  assert.equal(s.detail, 'New response in the terminal');

  // Exit via /exit: SessionEnd after the result acknowledges it.
  rmSync(join(f.config, 'sessions', '20.json'));
  f.hook(uuid(5), 'end', { at: '2500', reason: 'prompt_input_exit' });
  s = await current();
  assert.equal(s.status, 'read');
  assert.equal(s.evidence, 'history');
  assert.equal(s.attentionKey, 'result:turn-1');
});

test('resume commands quote directories and reject anything but a session uuid', () => {
  const base = {
    id: 'claude:x',
    provider: 'claude' as const,
    externalId: 'x',
    title: 't',
    status: 'read' as const,
    detail: '',
    updatedAt: 0,
    observedAt: 0,
    evidence: 'live' as const,
    attentionKey: null,
    archived: false,
  };
  assert.equal(
    resumeCommand({ ...base, directory: "/w/it's; rm -rf ~", resumeId: uuid(1) }),
    `cd '/w/it'\\''s; rm -rf ~' && claude --resume ${uuid(1)}`,
  );
  assert.equal(
    resumeCommand({ ...base, directory: null, resumeId: uuid(1) }),
    `claude --resume ${uuid(1)}`,
  );
  assert.equal(resumeCommand({ ...base, directory: '/w', resumeId: '$(touch x)' }), null);
  assert.equal(
    resumeCommand({ ...base, provider: 'codex', directory: '/w', resumeId: uuid(1) }),
    null,
  );
});

test('a desktop session resumed in a terminal stays one task and shows running', async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  let sessions: Session[] = [];
  const provider = new ClaudeProvider({
    desktopDir: f.desktop,
    configDir: f.config,
    hooksDir: f.hooks,
    desktopRunning: async () => true,
    processAlive: () => true,
    pollMs: 60_000,
  });
  t.after(() => provider.stop());
  f.record(A, { lastAssistantUuid: uuid(1), completedTurns: 1 });
  f.proc(21, { entrypoint: 'cli', kind: 'interactive', sessionId: A.slice(6), status: 'busy' });
  f.hook(A.slice(6), 'result', { at: '3000', kind: 'stop', prompt: 'p' });
  await provider.start({ sessions: (v) => (sessions = v), health: () => {} });
  assert.deepEqual(
    sessions.map((s) => [s.externalId, s.status]),
    [[A, 'running']],
  );
});

test('the plugin hook script writes only whitelisted fields the provider can read', (t) => {
  const f = fixture();
  t.after(() => rmSync(f.root, { recursive: true }));
  const id = uuid(6);
  const run = (input: object, entrypoint = 'cli') =>
    spawnSync('/bin/sh', ['plugins/monitor-hooks/hooks/record.sh'], {
      input: JSON.stringify(input),
      env: {
        ...process.env,
        MONITOR_CLAUDE_HOOKS_DIR: f.hooks,
        CLAUDE_CODE_ENTRYPOINT: entrypoint,
      },
    });
  const cwd = "/work/it's here";
  run({
    session_id: id,
    hook_event_name: 'SessionStart',
    cwd,
    source: 'startup',
    session_title: 'Fix\nlogin',
  });
  run({ session_id: id, hook_event_name: 'UserPromptSubmit', cwd, prompt_text: 'SECRET PROMPT' });
  run({
    session_id: id,
    hook_event_name: 'Stop',
    cwd,
    prompt_id: 'turn-1',
    last_assistant_message: 'SECRET RESPONSE',
  });
  run({ session_id: id, hook_event_name: 'Stop', cwd, agent_id: 'sub', prompt_id: 'subagent' });
  run({ session_id: '../../escape', hook_event_name: 'Stop', cwd });
  run({ session_id: uuid(7), hook_event_name: 'Stop', cwd, prompt_id: 'd' }, 'claude-desktop');
  const written = readdirSync(f.hooks);
  assert.deepEqual(written.sort(), [`${id}.result`, `${id}.start`, `${uuid(7)}.result`].sort());
  for (const name of written)
    assert.doesNotMatch(readFileSync(join(f.hooks, name), 'utf8'), /SECRET/);
  const hooks = readHookSessions(f.hooks);
  const session = hooks.get(id)!;
  assert.equal(session.entrypoint, 'cli');
  assert.equal(session.cwd, cwd);
  assert.equal(session.title, 'Fix login');
  assert.equal(session.result!.key, 'result:turn-1');
  assert.equal(hooks.get(uuid(7))!.entrypoint, 'claude-desktop');
});
