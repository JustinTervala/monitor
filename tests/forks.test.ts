import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState, isQueued, newGroup } from '../src/shared/queue';
import { forkDescendants, forkFamily, forkPath, visibleForks } from '../src/shared/forks';
import { commandSchema } from '../src/main/commands';
import { session } from './helpers';

function fixture() {
  const state = emptyState();
  const tasks = [
    session('root00', { lineage: { parentId: null }, createdAt: 1 }),
    session('child1', { lineage: { parentId: 'codex:root00' }, createdAt: 2 }),
    session('child2', { lineage: { parentId: 'codex:root00' }, createdAt: 3 }),
    session('nested', { lineage: { parentId: 'codex:child1' }, createdAt: 4 }),
    session('other0'),
  ];
  state.sessions = Object.fromEntries(tasks.map((s) => [s.id, s]));
  state.groups = tasks.map((s, i) => ({ ...newGroup(s.id), name: `Group ${i}` }));
  state.groups[1].archived = true;
  state.groups[2].inQueue = false;
  state.groups[3].snooze = { until: null };
  return state;
}

test('fork family spans groups, queue, library, snoozes, and Monitor archives in stable source order', () => {
  const state = fixture(),
    before = structuredClone(state);
  const family = forkFamily(state, 'codex:nested')!;
  assert.deepEqual(
    [...family.nodes.keys()],
    ['codex:root00', 'codex:child1', 'codex:nested', 'codex:child2'],
  );
  assert.deepEqual(
    [...forkPath(family, 'codex:nested')],
    ['codex:nested', 'codex:child1', 'codex:root00'],
  );
  assert.equal(family.nodes.get('codex:nested')?.depth, 2);
  assert.deepEqual(state, before);
  state.sessions['codex:child2'].status = 'review';
  state.sessions['codex:child2'].updatedAt = 999999;
  state.sessions['codex:child2'].title = 'A renamed task';
  assert.deepEqual([...forkFamily(state, 'codex:child2')!.nodes.keys()], [...family.nodes.keys()]);
});

test('focus keeps the selected path and descendants; collapse omits only that subtree', () => {
  const family = forkFamily(fixture(), 'codex:child1')!;
  assert.deepEqual(
    visibleForks(family, 'codex:child1', new Set(), true).map((n) => n.id),
    ['codex:root00', 'codex:child1', 'codex:nested'],
  );
  assert.deepEqual(
    visibleForks(family, 'codex:child2', new Set(['codex:child1']), false).map((n) => n.id),
    ['codex:root00', 'codex:child1', 'codex:child2'],
  );
  assert.deepEqual(
    forkDescendants(family, 'codex:child1').map((n) => n.id),
    ['codex:nested'],
  );
});

test('missing and source-hidden parents connect siblings without disclosing the hidden task', () => {
  const state = fixture();
  state.sessions['codex:root00'].archived = true;
  const family = forkFamily(state, 'codex:child1')!;
  assert.equal(family.nodes.get('codex:root00')?.session, undefined);
  assert.equal(family.nodes.size, 4);
  assert.equal(forkFamily(state, 'codex:root00'), null);
  delete state.sessions['codex:root00'];
  assert.deepEqual([...forkFamily(state, 'codex:child2')!.nodes.keys()], [...family.nodes.keys()]);
});

test('unavailable lineage is not inferred from names or directories; providers stay separate', () => {
  const state = fixture();
  state.sessions['codex:other0'].title = state.sessions['codex:root00'].title;
  state.sessions['codex:other0'].lineage = { parentId: 'claude:root00' };
  assert.equal(forkFamily(state, 'codex:other0')?.nodes.size, 1);
});

test('source cycles are broken consistently, including self-parent links', () => {
  const state = fixture();
  state.sessions['codex:root00'].lineage = { parentId: 'codex:nested' };
  const first = forkFamily(state, 'codex:nested')!,
    second = forkFamily(state, 'codex:root00')!;
  assert.equal(first.hasCycle, true);
  assert.equal(first.rootId, second.rootId);
  assert.equal(first.nodes.size, 4);
  state.sessions['codex:other0'].lineage = { parentId: 'codex:other0' };
  assert.equal(forkFamily(state, 'codex:other0')?.hasCycle, true);
});

test('deep histories traverse without recursive call-stack limits', () => {
  const state = emptyState();
  for (let i = 0; i < 6000; i++) {
    const task = session(`deep-${i}`, { lineage: { parentId: i ? `codex:deep-${i - 1}` : null } });
    state.sessions[task.id] = task;
  }
  const family = forkFamily(state, 'codex:deep-5999')!;
  assert.equal(family.nodes.size, 6000);
  assert.equal(forkDescendants(family, family.rootId).length, 5999);
  assert.equal(visibleForks(family, 'codex:deep-5999', new Set(), true).length, 6000);
});

test('assigning one task preserves ancestry, peers, and both groups organization', () => {
  const state = fixture();
  state.groups[0].sessionIds.push('codex:other0');
  state.groups.pop();
  const original = structuredClone(state);
  const command = commandSchema.parse({
    type: 'assign',
    sessionId: 'codex:root00',
    targetId: state.groups[3].id,
  });
  const next = applyCommand(state, command);
  assert.deepEqual(next.sessions, state.sessions);
  assert.deepEqual(
    next.groups.map((g) => ({ ...g, sessionIds: [] })),
    state.groups.map((g) => ({ ...g, sessionIds: [] })),
  );
  assert.deepEqual(next.groups[0].sessionIds, ['codex:other0']);
  assert.deepEqual(next.groups[3].sessionIds, ['codex:nested', 'codex:root00']);
  assert.deepEqual(state, original);
  const movedAgain = applyCommand(next, {
    type: 'assign',
    sessionId: 'codex:other0',
    targetId: next.groups[3].id,
  });
  assert.equal(movedAgain.groups[0].name, original.groups[0].name);
  assert.deepEqual(movedAgain.groups[0].sessionIds, []);
  assert.equal(isQueued(movedAgain.groups[0]), false);
  assert.throws(() =>
    applyCommand(state, { type: 'assign', sessionId: 'missing', targetId: state.groups[0].id }),
  );
  state.sessions['codex:root00'].archived = true;
  assert.throws(() => applyCommand(state, command));
});
