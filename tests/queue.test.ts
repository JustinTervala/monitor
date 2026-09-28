import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, emptyState, groupSection, newGroup, projectTag } from '../src/shared/queue';
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
test('ordering is relative across sections and survives tracking/removal', () => {
  let state = fixture();
  const [a, b, c] = state.groups;
  state = applyCommand(state, { type: 'move', groupId: c.id, targetId: a.id, placement: 'before' });
  assert.deepEqual(
    state.groups.map((g) => g.id),
    [c.id, a.id, b.id],
  );
  state = applyCommand(state, { type: 'remove', groupId: a.id });
  assert.ok(state.sessions['codex:aaaaaa']);
  state = applyCommand(state, { type: 'track', sessionId: 'codex:aaaaaa' });
  assert.equal(state.groups.at(-1)?.sessionIds[0], 'codex:aaaaaa');
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
  assert.equal(
    commandSchema.safeParse({ type: 'track', sessionId: 'x', status: 'running' }).success,
    false,
  );
});
