import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SummaryQueue, SUMMARY_DELAY_MS, type SummaryRunner } from '../src/main/summaries/queue';
import { MonitorService } from '../src/main/service';
import { MonitorStore } from '../src/main/store';
import { emptyState, newGroup } from '../src/shared/queue';
import { handoffSummary } from '../src/shared/summary';
import type { ObserverCallbacks, SessionProvider } from '../src/providers/provider';
import type { Session } from '../src/shared/types';
import { session } from './helpers';

const result = (id = 'aaaaaa', key = 'fresh') =>
  session(id, {
    status: 'review',
    attentionKey: `result:${key}`,
    activityAt: 100,
  });
function setup(t: TestContext, run?: SummaryRunner) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const state = emptyState(),
    calls: string[] = [],
    reads: string[] = [];
  const queue = new SummaryQueue(
    () => state,
    async (s) => {
      reads.push(s.id);
      return 'Synthetic final response';
    },
    {
      run:
        run ??
        (async (text) => {
          calls.push(text);
          return 'Done, PR #324.';
        }),
    },
    () => {},
  );
  t.after(() => queue.stop());
  const emit = (s: Session, first = false) => {
    if (!state.groups.some((g) => g.sessionIds.includes(s.id))) state.groups.push(newGroup(s.id));
    state.sessions[s.id] = s;
    queue.observe(s, first);
    queue.reconcile();
  };
  const advance = async (ms = SUMMARY_DELAY_MS) => {
    t.mock.timers.tick(ms);
    await setImmediate();
  };
  return { state, calls, reads, queue, emit, advance };
}

test('no backlog, cache-miss or first-history backfill; fresh results wait five quiet minutes', async (t) => {
  const f = setup(t);
  f.emit(result('aaaaaa', 'old'), true);
  await f.advance();
  assert.deepEqual(f.reads, []);
  // Metadata activity updates for a first idle result must not admit old work.
  f.emit({ ...result('aaaaaa', 'old'), activityAt: 101 });
  await f.advance();
  assert.deepEqual(f.reads, []);
  f.emit(session('aaaaaa', { status: 'running' }));
  f.emit(result());
  await f.advance(SUMMARY_DELAY_MS - 1);
  assert.deepEqual(f.reads, []);
  await f.advance(1);
  assert.equal(f.state.summaries['codex:aaaaaa'].text, 'Done, PR #324.');
  assert.deepEqual(f.calls, ['Synthetic final response']);
  f.emit(result());
  await f.advance();
  assert.equal(f.calls.length, 1);
});

test('read, open, resume, request, snooze, archive and offline cancel pending work', async (t) => {
  for (const change of ['read', 'open', 'running', 'request', 'snooze', 'archive', 'offline']) {
    await t.test(change, async (t) => {
      const f = setup(t);
      f.emit(result('aaaaaa', 'old'), true);
      f.emit(result());
      if (change === 'open') f.queue.opened('codex:aaaaaa');
      else if (change === 'snooze') f.state.groups[0].snooze = { until: null };
      else if (change === 'archive') f.state.groups[0].archived = true;
      else if (change === 'request')
        f.emit({ ...result(), awaitingInput: true, attentionKey: 'request:q' });
      else if (change === 'offline')
        f.emit({ ...result(), status: 'unknown', evidence: 'unavailable', attentionKey: null });
      else f.emit({ ...result(), status: change as 'read' | 'running' });
      f.queue.reconcile();
      await f.advance();
      assert.deepEqual(f.reads, []);
      f.state.groups[0].snooze = null;
      f.state.groups[0].archived = false;
      f.emit(result(), change === 'offline');
      await f.advance();
      assert.deepEqual(f.reads, []);
    });
  }
});

test('later activity within a pending completion resets the inactivity deadline', async (t) => {
  const f = setup(t);
  f.emit(result('aaaaaa', 'old'), true);
  f.emit(result());
  await f.advance(200_000);
  f.emit({ ...result(), activityAt: 102 });
  await f.advance(100_000);
  assert.deepEqual(f.reads, []);
  await f.advance(200_000);
  assert.equal(f.calls.length, 1);
});

test('one job at a time; a cancelled active result cannot overwrite its successor', async (t) => {
  let finish!: (text: string) => void,
    signal!: AbortSignal,
    calls = 0;
  const f = setup(t, async (_response, abort) => {
    calls++;
    if (calls > 1) return 'Needs a decision on auth.';
    signal = abort;
    return await new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  f.emit(result('aaaaaa', 'old'), true);
  f.emit(result('bbbbbb', 'old'), true);
  f.emit(result());
  f.emit(result('bbbbbb'));
  await f.advance();
  assert.equal(calls, 1);
  f.emit(session('aaaaaa', { status: 'running' }));
  assert.equal(signal.aborted, true);
  f.emit(result('aaaaaa', 'next'));
  finish('Stale answer.');
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(Object.keys(f.state.summaries).includes('codex:aaaaaa'), false);
  await f.advance();
  assert.equal(calls, 3);
  assert.equal(f.state.summaries['codex:aaaaaa'].completionKey, 'result:next');
});

test('cached summaries survive reads, disappear on new work and are erased on either archive', async (t) => {
  const f = setup(t);
  f.emit(result('aaaaaa', 'old'), true);
  f.emit(result());
  await f.advance();
  f.emit({ ...result(), status: 'read' });
  assert.equal(handoffSummary(f.state, f.state.sessions['codex:aaaaaa']), 'Done, PR #324.');
  f.emit(session('aaaaaa', { status: 'running' }));
  assert.deepEqual(f.state.summaries, {});
  f.emit(result('aaaaaa', 'next'));
  await f.advance();
  f.state.groups[0].archived = true;
  f.queue.reconcile();
  assert.deepEqual(f.state.summaries, {});
  f.state.groups[0].archived = false;
  f.queue.reconcile();
  await f.advance();
  assert.equal(f.calls.length, 2);
  f.emit(result('aaaaaa', 'newest'));
  await f.advance();
  f.emit({ ...result('aaaaaa', 'newest'), archived: true });
  assert.deepEqual(f.state.summaries, {});
});

test('shutdown aborts active work and discards late output', async (t) => {
  let finish!: (s: string) => void, signal!: AbortSignal;
  const f = setup(t, (_response, abort) => {
    signal = abort;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  f.emit(result('aaaaaa', 'old'), true);
  f.emit(result());
  await f.advance();
  f.queue.stop();
  assert.equal(signal.aborted, true);
  finish('Late result.');
  await setImmediate();
  assert.deepEqual(f.state.summaries, {});
});

class FakeProvider implements SessionProvider {
  readonly id = 'codex' as const;
  callbacks!: ObserverCallbacks;
  async start(callbacks: ObserverCallbacks) {
    this.callbacks = callbacks;
  }
  emit(s: Session) {
    this.callbacks.sessions([s]);
  }
  track() {}
  async refresh() {}
  stop() {}
  sessionUrl() {
    return 'codex://threads/aaaaaa';
  }
  async readCompletedResponse() {
    return 'Synthetic private response marker.';
  }
}
test('service persists only the latest summary; restart reuses cache without backfill and group archive deletes it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const root = mkdtempSync(join(tmpdir(), 'monitor-summary-store-')),
    database = join(root, 'state.sqlite');
  const provider = new FakeProvider();
  let calls = 0;
  const options = {
    run: async () => {
      calls++;
      return 'Done, PR #324.';
    },
  };
  let service = new MonitorService(new MonitorStore(database), [provider], () => {}, options);
  t.after(() => {
    service.stop();
    rmSync(root, { recursive: true });
  });
  await service.start();
  provider.emit(result('aaaaaa', 'old'));
  provider.emit(result());
  t.mock.timers.tick(SUMMARY_DELAY_MS);
  await setImmediate();
  service.stop();
  assert.equal(
    readFileSync(database).includes(Buffer.from('Synthetic private response marker')),
    false,
  );
  service = new MonitorService(new MonitorStore(database), [provider], () => {}, options);
  await service.start();
  provider.emit(result());
  t.mock.timers.tick(SUMMARY_DELAY_MS);
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(service.snapshot().state.summaries['codex:aaaaaa'].text, 'Done, PR #324.');
  service.command({ type: 'archive', groupId: service.snapshot().state.groups[0].id });
  assert.deepEqual(service.snapshot().state.summaries, {});
  service.command({ type: 'restore', groupId: service.snapshot().state.groups[0].id });
  t.mock.timers.tick(SUMMARY_DELAY_MS);
  await setImmediate();
  assert.equal(calls, 1);
});

test('history hooks cannot baseline a different old result arriving in the first live snapshot', async (t) => {
  const f = setup(t);
  f.emit({ ...result('aaaaaa', 'old-hook'), evidence: 'history' }, true);
  // The service has already baselined notification history. Summary admission
  // still needs its own first live observation to avoid a desktop backlog.
  f.emit(result('aaaaaa', 'old-desktop'));
  await f.advance();
  assert.deepEqual(f.reads, []);
  f.emit(result('aaaaaa', 'fresh'));
  await f.advance();
  assert.equal(f.calls.length, 1);
  f.emit({ ...result('aaaaaa', 'history-only'), evidence: 'history' });
  f.emit(result('aaaaaa', 'reconnected-old'));
  await f.advance();
  assert.equal(f.calls.length, 1);
});
