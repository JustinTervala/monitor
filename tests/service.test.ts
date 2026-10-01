import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MonitorService, type NotificationEvent } from '../src/main/service';
import { MonitorStore } from '../src/main/store';
import type { ObserverCallbacks, SessionProvider } from '../src/providers/provider';
import { session } from './helpers';
import type { Session } from '../src/shared/types';
import { emptyState, groupSection, newGroup } from '../src/shared/queue';

class FakeProvider implements SessionProvider {
  constructor(readonly id: SessionProvider['id'] = 'codex') {}
  callbacks!: ObserverCallbacks;
  tracked: string[] = [];
  async start(callbacks: ObserverCallbacks) {
    this.callbacks = callbacks;
  }
  emit(...sessions: Session[]) {
    this.callbacks.sessions(sessions);
  }
  track(ids: string[]) {
    this.tracked = ids;
  }
  async refresh() {}
  stop() {}
  sessionUrl(id: string) {
    return `${this.id}://threads/${id}`;
  }
}

test('terminal resume refreshes source state and refuses a live task', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-resume-'));
  const provider = new FakeProvider();
  const service = new MonitorService(
    new MonitorStore(join(path, 'state.sqlite')),
    [provider],
    () => {},
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  const id = '00000000-0000-4000-8000-000000000001';
  const exited = session(id, { resumeId: id, status: 'review', terminalResumeAllowed: true });
  provider.emit(exited);
  assert.equal(
    await service.terminalResumeCommand(exited.id),
    `cd '/work/project' && codex resume ${id}`,
  );
  provider.refresh = async () => provider.emit({ ...exited, terminalPid: 42 });
  await assert.rejects(service.terminalResumeCommand(exited.id), /still be active/);
  provider.refresh = async () => provider.emit({ ...exited, terminalResumeAllowed: false });
  await assert.rejects(service.terminalResumeCommand(exited.id), /still be active/);
});
test('initial results are quiet; new result notifies once, even if already read in Codex', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const provider = new FakeProvider(),
    notices: NotificationEvent[] = [];
  const service = new MonitorService(
    new MonitorStore(join(path, 'state.sqlite')),
    [provider],
    (n) => notices.push(n),
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(session('aaaaaa', { status: 'read', attentionKey: null }));
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:old' }));
  assert.equal(notices.length, 0);
  assert.deepEqual(provider.tracked, ['aaaaaa']);
  provider.emit(session('aaaaaa'));
  provider.emit(session('aaaaaa', { status: 'read', attentionKey: 'result:new' }));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].body, 'Codex · Turn finished');
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:new' }));
  assert.equal(notices.length, 1);
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'request:approval' }));
  assert.equal(notices.length, 2);
});

test('every discovered task is admitted automatically, including later provider arrivals', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const codex = new FakeProvider(),
    claude = new FakeProvider('claude');
  const notices: NotificationEvent[] = [];
  const service = new MonitorService(
    new MonitorStore(join(path, 'state.sqlite')),
    [codex, claude],
    (n) => notices.push(n),
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  codex.emit(); // Empty initial catalog must not disable later discovery.
  const tasks = Array.from({ length: 250 }, (_, i) =>
    session(`task-${i}`, { status: 'unknown', evidence: 'unavailable', updatedAt: i }),
  );
  codex.emit(...tasks, session('archived', { archived: true }));
  assert.equal(service.snapshot().state.groups.length, 250);
  assert.equal(codex.tracked.length, 250);
  const original = service.snapshot().state.groups;
  codex.emit(...tasks.reverse());
  assert.deepEqual(service.snapshot().state.groups, original);
  const later = session('later-task', { updatedAt: 1000 });
  codex.emit(later);
  assert.equal(service.snapshot().state.groups.at(-1)?.sessionIds[0], later.id);
  assert.ok(codex.tracked.includes(later.externalId));
  codex.emit({ ...later, status: 'review', attentionKey: 'result:later-task' });
  assert.equal(notices.length, 1); // An automatically admitted task can notify normally.
  claude.emit(
    session('first-claude', {
      id: 'claude:first-claude',
      provider: 'claude',
      status: 'read',
      attentionKey: 'result:old',
    }),
  );
  assert.equal(service.snapshot().state.groups.length, 252);
  assert.deepEqual(claude.tracked, ['first-claude']);
  assert.equal(notices.length, 1); // Initial historical completion remains quiet.
});

test('hook history is quiet, a later completion notifies once across hook and desktop channels', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-hooks-service-'));
  const provider = new FakeProvider(),
    notices: NotificationEvent[] = [];
  const service = new MonitorService(
    new MonitorStore(join(path, 'state.sqlite')),
    [provider],
    (n) => notices.push(n),
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(
    session('aaaaaa', {
      status: 'review',
      evidence: 'history',
      attentionKey: 'result:old',
      updatedAt: Date.now(),
    }),
  );
  assert.equal(notices.length, 0);
  assert.equal(service.snapshot().state.notificationKeys['codex:aaaaaa'], 'result:old');
  // A fast turn can finish between polls; history still establishes the baseline.
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:new' }));
  assert.equal(notices.length, 1);
  provider.emit(
    session('aaaaaa', { status: 'read', attentionKey: 'result:new', detail: 'Read in Codex' }),
  );
  assert.equal(notices.length, 1);
  provider.emit(session('aaaaaa'));
  provider.emit(
    session('aaaaaa', {
      status: 'unknown',
      evidence: 'unavailable',
      detail: 'Stop hook; no confirmed result',
    }),
  );
  provider.callbacks.health({
    provider: 'codex',
    state: 'degraded',
    message: 'Using companion observations',
    lastObservedAt: null,
  });
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:next' }));
  assert.equal(notices.length, 2);
});

test('upgrading an already initialized queue discovers omissions without resetting workstreams', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const store = new MonitorStore(join(path, 'state.sqlite'));
  const a = session('aaaaaa'),
    b = session('bbbbbb'),
    c = session('cccccc');
  const grouped = {
    ...newGroup(a.id),
    name: 'My workstream',
    projectOverride: 'Custom project',
    sessionIds: [a.id, b.id],
    snooze: { until: null },
  };
  const legacy = {
    ...emptyState(),
    initialized: true,
    sessions: { [a.id]: a, [b.id]: b, [c.id]: c },
    groups: [structuredClone(grouped)],
    notifications: false,
    notificationKeys: { [a.id]: 'result:old' },
  };
  Reflect.set(legacy, 'version', 1);
  Reflect.deleteProperty(legacy.groups[0], 'archived');
  store.write(legacy);
  const provider = new FakeProvider();
  const service = new MonitorService(store, [provider], () =>
    assert.fail('Discovery must not notify'),
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(c, a, b); // Includes cached metadata that was never manually imported.
  const state = service.snapshot().state;
  assert.deepEqual(state.groups[0], grouped);
  assert.equal(state.groups.length, 2);
  assert.deepEqual(state.groups[1].sessionIds, [c.id]);
  assert.equal(state.notifications, false);
  assert.equal(state.notificationKeys[a.id], 'result:old');
  assert.equal(Object.hasOwn(state, 'initialized'), false);
  provider.emit(a, b, c);
  assert.deepEqual(service.snapshot().state.groups, state.groups);
});
test('snooze suppresses events, never replays on wake, and persists ordering and dedup', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-')),
    database = join(path, 'state.sqlite');
  const notices: NotificationEvent[] = [];
  let provider = new FakeProvider();
  let service = new MonitorService(new MonitorStore(database), [provider], (n) => notices.push(n));
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(session('aaaaaa'), session('bbbbbb'));
  const [a, b] = service.snapshot().state.groups;
  service.command({ type: 'move', groupId: b.id, targetId: a.id, placement: 'before' });
  service.command({ type: 'snooze', groupId: a.id, until: null });
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:snoozed' }));
  assert.equal(notices.length, 0);
  service.command({ type: 'unsnooze', groupId: a.id });
  provider.emit(
    session('aaaaaa', { status: 'review', attentionKey: 'result:snoozed', observedAt: 3 }),
  );
  assert.equal(notices.length, 0);
  provider.emit(session('aaaaaa'));
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:new' }));
  assert.equal(notices.length, 1);
  service.stop();
  provider = new FakeProvider();
  service = new MonitorService(new MonitorStore(database), [provider], (n) => notices.push(n));
  await service.start();
  assert.deepEqual(
    service.snapshot().state.groups.map((g) => g.id),
    [b.id, a.id],
  );
  assert.equal(service.snapshot().state.sessions['codex:aaaaaa'].status, 'unknown');
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:new' }));
  assert.equal(notices.length, 1);
  provider.callbacks.health({
    provider: 'codex',
    state: 'offline',
    message: 'Offline',
    lastObservedAt: null,
  });
  provider.emit(session('aaaaaa', { status: 'unknown', evidence: 'unavailable' }));
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:while-disconnected' }));
  assert.equal(notices.length, 1);
});
test('timer expires snooze without changing task state or replaying notification', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const provider = new FakeProvider(),
    notices: NotificationEvent[] = [];
  const service = new MonitorService(
    new MonitorStore(join(path, 'state.sqlite')),
    [provider],
    (n) => notices.push(n),
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(session('aaaaaa'));
  const id = service.snapshot().state.groups[0].id;
  service.command({ type: 'snooze', groupId: id, until: Date.now() + 40 });
  provider.emit(session('aaaaaa', { status: 'review', attentionKey: 'result:quiet' }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(service.snapshot().state.groups[0].snooze, null);
  assert.equal(service.snapshot().state.sessions['codex:aaaaaa'].status, 'review');
  assert.equal(notices.length, 0);
});

test('archive persists, keeps observing without rediscovery or notifications, and restores quietly', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const database = join(path, 'state.sqlite');
  const notices: NotificationEvent[] = [];
  let provider = new FakeProvider();
  let service = new MonitorService(new MonitorStore(database), [provider], (n) => notices.push(n));
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(session('aaaaaa'), session('bbbbbb'));
  const [a, b] = service.snapshot().state.groups;
  service.command({ type: 'archive', groupId: a.id });
  assert.deepEqual(provider.tracked, ['aaaaaa', 'bbbbbb']);
  const finished = session('aaaaaa', {
    status: 'review',
    attentionKey: 'result:archived',
    updatedAt: 5,
  });
  provider.emit(finished, session('bbbbbb'));
  assert.equal(notices.length, 0);
  assert.equal(service.snapshot().state.groups.length, 2);
  assert.deepEqual(service.snapshot().state.sessions[finished.id], finished);
  service.stop();
  provider = new FakeProvider();
  service = new MonitorService(new MonitorStore(database), [provider], (n) => notices.push(n));
  await service.start();
  provider.emit(finished, session('bbbbbb'));
  assert.deepEqual(service.snapshot().state.groups, [{ ...a, archived: true }, b]);
  service.command({ type: 'restore', groupId: a.id });
  provider.emit(finished);
  assert.equal(notices.length, 0);
  assert.deepEqual(service.snapshot().state.groups, [a, b]);
  provider.emit(session('aaaaaa'));
  provider.emit({ ...finished, attentionKey: 'result:after-restore' });
  assert.equal(notices.length, 1);
});

test('a Claude result in a snoozed or archived mixed-provider group updates quietly', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-test-'));
  const codex = new FakeProvider('codex'),
    claude = new FakeProvider('claude'),
    notices: NotificationEvent[] = [];
  const service = new MonitorService(
    new MonitorStore(join(path, 'state.sqlite')),
    [codex, claude],
    (n) => notices.push(n),
  );
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  const claudeSession = (extra: Partial<Session> = {}) =>
    session('local_x', { id: 'claude:local_x', provider: 'claude', ...extra });
  await service.start();
  codex.emit(session('aaaaaa'));
  claude.emit(claudeSession());
  const [a, b] = service.snapshot().state.groups;
  service.command({ type: 'merge', sourceId: b.id, targetId: a.id, name: 'Billing' });
  assert.deepEqual(claude.tracked, ['local_x']);
  const group = service.snapshot().state.groups[0];
  service.command({ type: 'snooze', groupId: group.id, until: null });
  claude.emit(claudeSession({ status: 'review', attentionKey: 'result:snoozed' }));
  assert.equal(service.snapshot().state.sessions['claude:local_x'].status, 'review');
  service.command({ type: 'unsnooze', groupId: group.id });
  service.command({ type: 'archive', groupId: group.id });
  claude.emit(claudeSession());
  claude.emit(claudeSession({ status: 'read', attentionKey: 'result:archived' }));
  assert.equal(service.snapshot().state.sessions['claude:local_x'].status, 'read');
  assert.equal(notices.length, 0);
  service.command({ type: 'restore', groupId: group.id });
  claude.emit(claudeSession());
  claude.emit(claudeSession({ status: 'review', attentionKey: 'result:active' }));
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Billing');
  assert.match(notices[0].body, /^Claude · /);
});

test('Library baselines old tasks, promotes genuine activity, and never revives explicit archives', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-library-'));
  const database = join(path, 'state.sqlite');
  const notices: NotificationEvent[] = [];
  let provider = new FakeProvider();
  let service = new MonitorService(new MonitorStore(database), [provider], (n) => notices.push(n));
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  const old = Date.now() - 30 * 86400000;
  const catalog = session('old-task', {
    status: 'unknown',
    evidence: 'unavailable',
    updatedAt: old,
  });
  const recent = session('recent-task', {
    status: 'unknown',
    evidence: 'unavailable',
    updatedAt: Date.now(),
  });
  const running = session('running-old', { updatedAt: old });
  const waiting = session('waiting-old', { status: 'review', awaitingInput: true, updatedAt: old });
  provider.emit(catalog, recent, running, waiting);
  const get = (id: string) =>
    service.snapshot().state.groups.find((g) => g.sessionIds.includes(`codex:${id}`))!;
  assert.equal(get('old-task').inQueue, false);
  assert.ok(['recent-task', 'running-old', 'waiting-old'].every((id) => get(id).inQueue));
  const oldResult = {
    ...catalog,
    status: 'review' as const,
    evidence: 'live' as const,
    activityAt: old,
    attentionKey: 'result:old',
  };
  provider.emit(oldResult);
  assert.equal(get('old-task').inQueue, false, 'history backfill is not new activity');
  provider.emit({ ...oldResult, status: 'read', updatedAt: Date.now() });
  assert.equal(get('old-task').inQueue, false, 'focus/catalog changes do not promote');
  assert.equal(notices.length, 0);
  const groupId = get('old-task').id;
  const order = service.snapshot().state.groups.map((g) => g.id);
  service.stop();
  provider = new FakeProvider();
  service = new MonitorService(new MonitorStore(database), [provider], (n) => notices.push(n));
  await service.start();
  provider.emit(oldResult);
  assert.equal(get('old-task').inQueue, false, 'reconnection and restart do not promote history');
  const finishedWhileAway = { ...oldResult, activityAt: Date.now(), attentionKey: 'result:new' };
  provider.emit(finishedWhileAway);
  assert.equal(get('old-task').inQueue, true, 'a new turn can finish between observations');
  assert.deepEqual(
    service.snapshot().state.groups.map((g) => g.id),
    order,
  );
  service.command({ type: 'archive', groupId });
  provider.emit({ ...finishedWhileAway, status: 'running', activityAt: Date.now() + 1 });
  assert.equal(get('old-task').archived, true);
  service.command({ type: 'restore', groupId });
  assert.equal(get('old-task').inQueue, true);
  assert.equal(get('old-task').archived, false);
});

test('disconnect and restart preserve qualified last-known placement without changing source status', async (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-last-known-'));
  const database = join(path, 'state.sqlite');
  let provider = new FakeProvider();
  let service = new MonitorService(new MonitorStore(database), [provider], () => {});
  t.after(() => {
    service.stop();
    rmSync(path, { recursive: true });
  });
  await service.start();
  provider.emit(session('aaaaaa'));
  const id = service.snapshot().state.groups[0].id;
  provider.emit(session('aaaaaa', { status: 'unknown', evidence: 'unavailable' }));
  let state = service.snapshot().state;
  assert.equal(state.sessions['codex:aaaaaa'].status, 'unknown');
  assert.equal(groupSection(state, state.groups[0]), 'running');
  service.stop();
  provider = new FakeProvider();
  service = new MonitorService(new MonitorStore(database), [provider], () => {});
  await service.start();
  state = service.snapshot().state;
  assert.equal(state.groups[0].id, id);
  assert.equal(groupSection(state, state.groups[0]), 'running');
  assert.equal(state.sessions['codex:aaaaaa'].status, 'unknown');
  provider.emit(session('aaaaaa', { status: 'read', attentionKey: 'result:new' }));
  state = service.snapshot().state;
  assert.equal(groupSection(state, state.groups[0]), 'read');
});

test('one-time Library migration preserves organization, priority, archives and receipts', (t) => {
  const path = mkdtempSync(join(tmpdir(), 'monitor-migration-'));
  const store = new MonitorStore(join(path, 'state.sqlite'));
  t.after(() => {
    store.close();
    rmSync(path, { recursive: true });
  });
  const state = emptyState();
  const old = Date.now() - 30 * 86400000;
  for (const id of ['old', 'named', 'snoozed', 'archived', 'recent', 'grouped']) {
    const s = session(id, { updatedAt: id === 'recent' ? Date.now() : old });
    state.sessions[s.id] = s;
    state.groups.push(newGroup(s.id));
  }
  state.groups[1].name = 'Keep this workstream';
  state.groups[1].projectOverride = 'Personal';
  state.groups[2].snooze = { until: null };
  state.groups[3].archived = true;
  const member = session('member', { updatedAt: old });
  state.sessions[member.id] = member;
  state.groups[5].sessionIds.push(member.id);
  state.notificationKeys[member.id] = 'result:seen';
  const before = structuredClone(state);
  Reflect.set(state, 'version', 1);
  Reflect.deleteProperty(state, 'observations');
  state.groups.forEach((g) => Reflect.deleteProperty(g, 'inQueue'));
  store.write(state);
  const upgraded = store.read();
  assert.deepEqual(
    upgraded.groups.map((g) => g.inQueue),
    [false, true, true, true, true, true],
  );
  assert.deepEqual(
    upgraded.groups.map(({ inQueue, ...rest }) => rest),
    before.groups.map(({ inQueue, ...rest }) => rest),
  );
  assert.deepEqual(upgraded.sessions, before.sessions);
  assert.deepEqual(upgraded.notificationKeys, before.notificationKeys);
  // This is an initial admission policy, not rolling eviction of old queue entries.
  upgraded.groups[0].inQueue = true;
  store.write(upgraded);
  assert.equal(store.read().groups[0].inQueue, true);
});
