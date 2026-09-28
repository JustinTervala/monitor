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

class FakeProvider implements SessionProvider {
  readonly id = 'codex';
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
    return `codex://threads/${id}`;
  }
}
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
