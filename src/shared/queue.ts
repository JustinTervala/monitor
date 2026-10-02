import type {
  Command,
  MonitorState,
  QueueSection,
  Session,
  SessionStatus,
  TaskGroup,
} from './types';

export const statusOrder: SessionStatus[] = ['review', 'running', 'read', 'unknown'];
export const sectionOrder: QueueSection[] = [...statusOrder, 'snoozed'];
export const sectionLabels: Record<QueueSection, string> = {
  review: 'Needs review',
  running: 'Running',
  read: 'Read',
  unknown: 'Status unavailable',
  snoozed: 'Snoozed',
};
export const emptyState = (): MonitorState => ({
  version: 2,
  sessions: {},
  groups: [],
  notifications: true,
  notificationKeys: {},
  observations: {},
});
export const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const isQueued = (group: TaskGroup) =>
  group.inQueue && !group.archived && group.sessionIds.length > 0;
export const isCurrentlyActive = (session: Session) =>
  session.evidence === 'live' && (session.status === 'running' || session.awaitingInput === true);
export const initiallyQueued = (session: Session, now = Date.now()) =>
  session.updatedAt >= now - RECENT_WINDOW_MS || isCurrentlyActive(session);
/** Last known status affects placement only; the session itself remains unknown. */
export const displayStatus = (state: MonitorState, session: Session): SessionStatus =>
  session.status === 'unknown'
    ? state.observations[session.id]?.lastKnown?.status || 'unknown'
    : session.status;
export const isSnoozed = (group: TaskGroup, now = Date.now()) =>
  group.snooze !== null && (group.snooze.until === null || group.snooze.until > now);
export const isHiddenSession = (session: Session) =>
  session.provider === 'codex' && session.archived;
export const groupSessions = (state: MonitorState, group: TaskGroup) =>
  group.sessionIds
    .map((id) => state.sessions[id])
    .filter((s): s is Session => Boolean(s) && !isHiddenSession(s));
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
    statusOrder.find((status) => sessions.some((s) => displayStatus(state, s) === status)) ||
    'unknown'
  );
}
export function groupProject(state: MonitorState, group: TaskGroup) {
  if (group.projectOverride)
    return { key: `name:${group.projectOverride}`, name: group.projectOverride, directory: null };
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
  if (!paths.length || paths.some((p) => !p))
    return { key: 'unknown', name: 'Project unknown', directory: null };
  if (new Set(paths).size !== 1)
    return { key: 'multiple', name: 'Multiple projects', directory: null };
  const directory = paths[0]!;
  return { key: `path:${directory}`, name: directory.split('/').pop() || '/', directory };
}
export const projectTag = (state: MonitorState, group: TaskGroup) =>
  groupProject(state, group).name;
export const groupUpdatedAt = (state: MonitorState, group: TaskGroup) =>
  Math.max(0, ...groupSessions(state, group).map((session) => session.updatedAt));

/** A separate project/recency view; never changes saved queue priority. */
export function archiveProjects(state: MonitorState, matches = (_group: TaskGroup) => true) {
  return libraryProjects(state, (group) => group.archived && matches(group));
}
export function libraryProjects(state: MonitorState, matches = (_group: TaskGroup) => true) {
  const projects = new Map<
    string,
    ReturnType<typeof groupProject> & { groups: TaskGroup[]; updatedAt: number }
  >();
  for (const group of state.groups) {
    if (!matches(group)) continue;
    const project = groupProject(state, group);
    let section = projects.get(project.key);
    if (!section) {
      section = { ...project, groups: [], updatedAt: 0 };
      projects.set(project.key, section);
    }
    section.groups.push(group);
    section.updatedAt = Math.max(section.updatedAt, groupUpdatedAt(state, group));
  }
  for (const project of projects.values())
    project.groups.sort(
      (a, b) => groupUpdatedAt(state, b) - groupUpdatedAt(state, a) || a.id.localeCompare(b.id),
    );
  return [...projects.values()].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
  );
}
export function newGroup(sessionId: string): TaskGroup {
  return {
    id: `group:${crypto.randomUUID()}`,
    name: null,
    projectOverride: null,
    sessionIds: [sessionId],
    archived: false,
    snooze: null,
    inQueue: true,
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
  const active = (id: string) => {
    const g = find(id);
    if (!isQueued(g)) throw new Error('Restore this workstream to the queue first.');
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
      const a = active(command.sourceId),
        b = active(command.targetId);
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
      const g = active(command.groupId);
      active(command.targetId);
      next.groups = next.groups.filter((x) => x.id !== g.id);
      const index = next.groups.findIndex((x) => x.id === command.targetId);
      next.groups.splice(index + (command.placement === 'after' ? 1 : 0), 0, g);
      break;
    }
    case 'snooze':
      if (command.until !== null && command.until <= now)
        throw new Error('Choose a future snooze time.');
      active(command.groupId).snooze = { until: command.until };
      break;
    case 'unsnooze':
      active(command.groupId).snooze = null;
      break;
    case 'archive': {
      const g = find(command.groupId);
      g.archived = true;
      g.snooze = null;
      break;
    }
    case 'restore': {
      const group = find(command.groupId);
      group.archived = false;
      group.inQueue = true;
      break;
    }
    case 'detach': {
      const g = find(command.groupId);
      if (g.sessionIds.length < 2 || !g.sessionIds.includes(command.sessionId))
        throw new Error('Choose a task from a group with multiple tasks.');
      g.sessionIds = g.sessionIds.filter((id) => id !== command.sessionId);
      next.groups.splice(next.groups.indexOf(g) + 1, 0, {
        ...newGroup(command.sessionId),
        archived: g.archived,
        inQueue: g.inQueue,
      });
      break;
    }
    case 'notifications':
      next.notifications = command.enabled;
      break;
    case 'assign': {
      const session = next.sessions[command.sessionId];
      if (!session || isHiddenSession(session)) throw new Error('This task is unavailable.');
      const target = find(command.targetId);
      const source = next.groups.find((g) => g.sessionIds.includes(command.sessionId));
      if (!source) throw new Error('This task no longer belongs to a group.');
      if (source === target) return state;
      // Move just this task; both groups keep their scheduling and organization.
      source.sessionIds = source.sessionIds.filter((id) => id !== command.sessionId);
      target.sessionIds.push(command.sessionId);
      // Retain empty named groups in storage so their settings are not discarded.
      if (!source.sessionIds.length && !source.name && !source.projectOverride)
        next.groups = next.groups.filter((g) => g !== source);
      break;
    }
  }
  return next;
}
