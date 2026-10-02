import assert from 'node:assert/strict';
import test from 'node:test';
import { groupDestinations } from '../src/renderer/group-picker';
import { emptyState, newGroup } from '../src/shared/queue';
import { session } from './helpers';

function fixture() {
  const state = emptyState();
  for (let i = 0; i < 9; i++) {
    const task = session(`task${i}`, {
      title: `Investigate issue ${i}`,
      updatedAt: 1000 + i,
      activityAt: i * 100,
      directory: '/Users/justin/work/payments',
    });
    state.sessions[task.id] = task;
    state.groups.push({ ...newGroup(task.id), id: `group${i}`, name: `Team ${i}` });
  }
  return state;
}

test('recent destinations follow actual member activity, exclude the current group, and preserve priority', () => {
  const state = fixture();
  // A recent title edit cannot outrank a more recent turn in another group.
  state.sessions['codex:task1'].updatedAt = 99999;
  // Source catalogs without a turn timestamp still supply a useful fallback.
  delete state.sessions['codex:task2'].activityAt;
  state.sessions['codex:task2'].updatedAt = 750;
  const before = structuredClone(state);
  assert.deepEqual(
    groupDestinations(state, 'group8', '', '/Users/justin').map((entry) => entry.group.id),
    ['group2', 'group7', 'group6', 'group5', 'group4', 'group3'],
  );
  assert.deepEqual(state, before);
  const member = session('recent-member', { activityAt: 900 });
  state.sessions[member.id] = member;
  state.groups[1].sessionIds.push(member.id);
  assert.equal(groupDestinations(state, 'group8', '', '/Users/justin')[0].group.id, 'group1');
});

test('search reaches older and empty groups by fuzzy names, project, and member metadata', () => {
  const state = fixture();
  state.groups[1].name = 'Performance';
  state.groups[1].archived = true;
  state.groups[2].snooze = { until: null };
  state.groups[3].inQueue = false;
  state.groups.push({ ...newGroup('missing'), id: 'empty', name: 'Later ideas', sessionIds: [] });
  const find = (query: string) => groupDestinations(state, 'group8', query, '/Users/justin');
  assert.equal(find('perfromance')[0].location, 'Archived in Monitor');
  assert.equal(find('issue 2')[0].location, 'Snoozed');
  assert.equal(find('issue 3')[0].location, 'In library');
  assert.equal(find('~/work/payments issue 1')[0].group.id, 'group1');
  assert.equal(find('later')[0].group.id, 'empty');
  assert.equal(find('issue').length, 8);
  assert.equal(find('Team 8').length, 0);
  assert.equal(find('nonexistent destination').length, 0);
});

test('source-archived task activity and titles do not influence destinations', () => {
  const state = fixture();
  const hidden = session('hidden-member', {
    archived: true,
    title: 'Private hidden task',
    activityAt: 9000,
  });
  state.sessions[hidden.id] = hidden;
  state.groups[1].sessionIds.push(hidden.id);
  const recent = groupDestinations(state, 'group8', '', '/Users/justin');
  assert.equal(recent[0].group.id, 'group7');
  assert.equal(groupDestinations(state, 'group8', 'private hidden', '/Users/justin').length, 0);
});
