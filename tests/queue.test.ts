import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand,
  archiveProjects,
  emptyState,
  groupSection,
  newGroup,
  projectTag,
} from '../src/shared/queue';
import { commandSchema } from '../src/main/commands';
import { session } from './helpers';

function fixture() {
  const state = emptyState();
  const a = session('aaaaaa'),
    b = session('bbbbbb', { status: 'review' }),
    c = session('cccccc', { status: 'read' });
  state.sessions = Object.fromEntries([a, b, c].map((s) => [s.id, s]));
  state.groups = [a, b, c].map((s) => newGroup(s.id));
  return state;
}
test('group precedence and section changes preserve global priority', () => {
  const state = fixture(),
    [a, b, c] = state.groups;
  const merged = applyCommand(state, {
    type: 'merge',
    sourceId: a.id,
    targetId: b.id,
    name: 'Release',
  });
  assert.deepEqual(
    merged.groups.map((g) => g.id),
    [b.id, c.id],
  );
  assert.equal(groupSection(merged, merged.groups[0]), 'review');
  merged.sessions['codex:bbbbbb'].status = 'read';
  assert.equal(groupSection(merged, merged.groups[0]), 'running');
  merged.sessions['codex:aaaaaa'].status = 'unknown';
  assert.equal(groupSection(merged, merged.groups[0]), 'unknown');
  merged.sessions['codex:aaaaaa'].status = 'read';
  assert.equal(groupSection(merged, merged.groups[0]), 'read');
  assert.deepEqual(
    merged.groups.map((g) => g.id),
    [b.id, c.id],
  );
});
test('snooze changes only group scheduling; expiry uses current state', () => {
  const state = fixture(),
    group = state.groups[0];
  const snoozed = applyCommand(state, { type: 'snooze', groupId: group.id, until: 200 }, 100);
  assert.deepEqual(snoozed.sessions, state.sessions);
  snoozed.sessions['codex:aaaaaa'].status = 'review';
  assert.equal(groupSection(snoozed, snoozed.groups[0], 150), 'snoozed');
  assert.equal(groupSection(snoozed, snoozed.groups[0], 201), 'review');
  assert.equal(snoozed.groups[0].id, group.id);
});
test('same leaf in different full paths is not a common project', () => {
  const state = fixture();
  state.groups[0].sessionIds.push('codex:bbbbbb');
  state.sessions['codex:aaaaaa'].directory = '/work/project/';
  assert.equal(projectTag(state, state.groups[0]), 'project');
  state.sessions['codex:aaaaaa'].directory = '/work/other/../project/.';
  assert.equal(projectTag(state, state.groups[0]), 'project');
  state.sessions['codex:bbbbbb'].directory = '/other/project';
  assert.equal(projectTag(state, state.groups[0]), 'Multiple projects');
  state.groups[0].projectOverride = 'Release';
  assert.equal(projectTag(state, state.groups[0]), 'Release');
});
test('merging retains target snooze; detach creates unique groups and memberships', () => {
  let state = fixture();
  const [a, b] = state.groups;
  state = applyCommand(state, { type: 'snooze', groupId: b.id, until: null });
  state = applyCommand(state, { type: 'merge', sourceId: a.id, targetId: b.id, name: 'Release' });
  assert.deepEqual(state.groups[0].snooze, { until: null });
  state = applyCommand(state, { type: 'detach', groupId: b.id, sessionId: 'codex:bbbbbb' });
  assert.equal(new Set(state.groups.map((g) => g.id)).size, 3);
  assert.equal(new Set(state.groups.flatMap((g) => g.sessionIds)).size, 3);
  assert.equal(state.groups[1].snooze, null);
});
test('ordering is relative across sections without changing membership', () => {
  let state = fixture();
  const [a, b, c] = state.groups;
  state = applyCommand(state, { type: 'move', groupId: c.id, targetId: a.id, placement: 'before' });
  assert.deepEqual(
    state.groups.map((g) => g.id),
    [c.id, a.id, b.id],
  );
  assert.equal(state.groups.flatMap((g) => g.sessionIds).length, 3);
});
test('renderer cannot write task status or snooze individual tasks', () => {
  assert.equal(
    commandSchema.safeParse({ type: 'status', sessionId: 'x', status: 'read' }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ type: 'snooze', sessionId: 'x', until: null }).success,
    false,
  );
  assert.equal(commandSchema.safeParse({ type: 'track', sessionId: 'x' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'remove', groupId: 'x' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'archive', sessionId: 'x' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'archive', groupId: 'x' }).success, true);
});

test('archive and restore preserve source state, group identity and saved priority', () => {
  let state = fixture();
  const [a, b] = state.groups;
  state = applyCommand(state, { type: 'merge', sourceId: b.id, targetId: a.id, name: 'Release' });
  state = applyCommand(state, { type: 'snooze', groupId: a.id, until: 200 }, 100);
  state.groups[0].projectOverride = 'My project';
  const before = structuredClone(state);
  state = applyCommand(state, { type: 'archive', groupId: a.id });
  assert.deepEqual(state.sessions, before.sessions);
  assert.deepEqual(
    state.groups,
    before.groups.map((g) => (g.id === a.id ? { ...g, archived: true, snooze: null } : g)),
  );
  assert.throws(
    () => applyCommand(state, { type: 'snooze', groupId: a.id, until: null }),
    /Restore/,
  );
  assert.throws(
    () =>
      applyCommand(state, {
        type: 'merge',
        sourceId: a.id,
        targetId: state.groups[1].id,
        name: 'Oops',
      }),
    /Restore/,
  );
  assert.throws(
    () =>
      applyCommand(state, {
        type: 'move',
        groupId: state.groups[1].id,
        targetId: a.id,
        placement: 'before',
      }),
    /Restore/,
  );
  state.sessions['codex:aaaaaa'].status = 'read';
  state.sessions['codex:bbbbbb'].status = 'read';
  state = applyCommand(state, { type: 'restore', groupId: a.id });
  assert.equal(groupSection(state, state.groups[0]), 'read');
  assert.deepEqual(
    state.groups,
    before.groups.map((g) => ({ ...g, snooze: null })),
  );
});

test('detaching from an archived group keeps both entries archived', () => {
  let state = fixture();
  const [a, b] = state.groups;
  state = applyCommand(state, { type: 'merge', sourceId: b.id, targetId: a.id, name: 'Release' });
  state = applyCommand(state, { type: 'archive', groupId: a.id });
  state = applyCommand(state, { type: 'detach', groupId: a.id, sessionId: 'codex:bbbbbb' });
  assert.deepEqual(
    state.groups.map((g) => g.archived),
    [true, true, false],
  );
  assert.equal(new Set(state.groups.flatMap((g) => g.sessionIds)).size, 3);
});

test('archive is grouped by full project identity and source recency, independent of priority', () => {
  const state = emptyState();
  const tasks = [
    session('old', { directory: '/work/project', updatedAt: 10, observedAt: 1000 }),
    session('new', { directory: '/work/other/../project/', updatedAt: 30 }),
    session('same-leaf', { directory: '/other/project', updatedAt: 20 }),
    session('custom', { directory: null, updatedAt: 5 }),
    session('unknown', { directory: null, updatedAt: 2 }),
    session('active', { updatedAt: 999 }),
  ];
  state.sessions = Object.fromEntries(tasks.map((s) => [s.id, s]));
  state.groups = tasks.map((s) => ({ ...newGroup(s.id), archived: s.externalId !== 'active' }));
  state.groups[3].projectOverride = 'project';
  const priority = state.groups.map((g) => g.id);
  const projects = archiveProjects(state);
  assert.deepEqual(
    projects.map((p) => p.key),
    ['path:/work/project', 'path:/other/project', 'name:project', 'unknown'],
  );
  assert.deepEqual(
    projects[0].groups.map((g) => g.sessionIds[0]),
    ['codex:new', 'codex:old'],
  );
  assert.equal(projects[0].updatedAt, 30);
  assert.deepEqual(
    state.groups.map((g) => g.id),
    priority,
  );
  assert.equal(archiveProjects(state, (g) => g.sessionIds.includes('codex:old')).length, 1);
  // A workstream with multiple tasks appears once, using the newest member activity.
  state.groups[0].sessionIds.push('codex:new');
  state.groups.splice(1, 1);
  assert.equal(archiveProjects(state)[0].groups.length, 1);
  assert.equal(archiveProjects(state)[0].updatedAt, 30);
  state.groups[0].sessionIds.push('codex:same-leaf');
  state.groups.splice(1, 1);
  assert.equal(archiveProjects(state)[0].key, 'multiple');
});
