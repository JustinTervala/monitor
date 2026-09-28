import type { Command, MonitorState, QueueSection, Session, TaskGroup } from './types';

export const sectionOrder: QueueSection[] = ['review', 'running', 'unknown', 'read', 'snoozed'];
export const sectionLabels: Record<QueueSection, string> = {
  review: 'Needs review',
  running: 'Running',
  read: 'Read',
  unknown: 'Status unavailable',
  snoozed: 'Snoozed',
};
export const emptyState = (): MonitorState => ({
  version: 1,
  initialized: false,
  sessions: {},
  groups: [],
  notifications: true,
  notificationKeys: {},
});
export const isSnoozed = (group: TaskGroup, now = Date.now()) =>
  group.snooze !== null && (group.snooze.until === null || group.snooze.until > now);
export const groupSessions = (state: MonitorState, group: TaskGroup) =>
  group.sessionIds.map((id) => state.sessions[id]).filter((s): s is Session => Boolean(s));
export const groupName = (state: MonitorState, group: TaskGroup) =>
  group.name || groupSessions(state, group)[0]?.title || 'Untitled task';
export function groupSection(
  state: MonitorState,
  group: TaskGroup,
  now = Date.now(),
): QueueSection {
  if (isSnoozed(group, now)) return 'snoozed';
  const sessions = groupSessions(state, group);
  return (
    (['review', 'running', 'unknown', 'read'].find((status) =>
      sessions.some((s) => s.status === status),
    ) as QueueSection) || 'unknown'
  );
}
export function projectTag(state: MonitorState, group: TaskGroup): string {
  if (group.projectOverride) return group.projectOverride;
  const paths = groupSessions(state, group).map((s) => {
    if (!s.directory) return null;
    const parts: string[] = [];
    for (const part of s.directory.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
      else if (part !== '..' || !s.directory.startsWith('/')) parts.push(part);
    }
    return `${s.directory.startsWith('/') ? '/' : ''}${parts.join('/')}` || '.';
  });
  if (!paths.length || paths.some((p) => !p)) return 'Project unknown';
  if (new Set(paths).size !== 1) return 'Multiple projects';
  return paths[0]!.split('/').pop() || '/';
}
export function newGroup(sessionId: string): TaskGroup {
  return {
    id: `group:${crypto.randomUUID()}`,
    name: null,
    projectOverride: null,
    sessionIds: [sessionId],
    snooze: null,
  };
}

/** User actions modify scheduling metadata, never provider-owned task status. */
export function applyCommand(
  state: MonitorState,
  command: Command,
  now = Date.now(),
): MonitorState {
  const next = structuredClone(state);
  const find = (id: string) => {
    const g = next.groups.find((g) => g.id === id);
    if (!g) throw new Error('This group no longer exists.');
    return g;
  };
  switch (command.type) {
    case 'rename': {
      const g = find(command.groupId);
      const name = command.name.trim();
      if (!name) throw new Error('Give the group a name.');
      g.name = name;
      g.projectOverride = command.projectOverride?.trim() || null;
      break;
    }
    case 'merge': {
      if (command.sourceId === command.targetId) return state;
      const a = find(command.sourceId),
        b = find(command.targetId);
      const name = command.name.trim();
      if (!name) throw new Error('Give the group a name.');
      const index = Math.min(next.groups.indexOf(a), next.groups.indexOf(b));
      // The drop target keeps its identity, project override and snooze policy.
      const merged = { ...b, name, sessionIds: [...new Set([...b.sessionIds, ...a.sessionIds])] };
      next.groups = next.groups.filter((g) => g !== a && g !== b);
      next.groups.splice(index, 0, merged);
      break;
    }
    case 'move': {
      if (command.groupId === command.targetId) return state;
      const g = find(command.groupId);
      find(command.targetId);
      next.groups = next.groups.filter((x) => x.id !== g.id);
      const index = next.groups.findIndex((x) => x.id === command.targetId);
      next.groups.splice(index + (command.placement === 'after' ? 1 : 0), 0, g);
      break;
    }
    case 'snooze':
      if (command.until !== null && command.until <= now)
        throw new Error('Choose a future snooze time.');
      find(command.groupId).snooze = { until: command.until };
      break;
    case 'unsnooze':
      find(command.groupId).snooze = null;
      break;
    case 'remove':
      find(command.groupId);
      next.groups = next.groups.filter((g) => g.id !== command.groupId);
      break;
    case 'track':
      if (!next.sessions[command.sessionId]) throw new Error('Session not found.');
      if (!next.groups.some((g) => g.sessionIds.includes(command.sessionId)))
        next.groups.push(newGroup(command.sessionId));
      break;
    case 'detach': {
      const g = find(command.groupId);
      if (g.sessionIds.length < 2 || !g.sessionIds.includes(command.sessionId))
        throw new Error('Choose a task from a group with multiple tasks.');
      g.sessionIds = g.sessionIds.filter((id) => id !== command.sessionId);
      next.groups.splice(next.groups.indexOf(g) + 1, 0, newGroup(command.sessionId));
      break;
    }
    case 'notifications':
      next.notifications = command.enabled;
      break;
  }
  return next;
}
