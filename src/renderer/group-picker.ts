import { groupName, groupProject, groupSessions, isQueued, isSnoozed } from '../shared/queue';
import type { MonitorState } from '../shared/types';
import { displayDirectory } from './directory';
import { createSearchMatcher } from './search';

export function groupDestinations(
  state: MonitorState,
  currentGroupId: string,
  query: string,
  homeDirectory: string,
) {
  const matches = createSearchMatcher(query);
  const destinations = state.groups
    .filter((group) => group.id !== currentGroupId)
    .map((group) => {
      const sessions = groupSessions(state, group);
      const name = groupName(state, group);
      const project = groupProject(state, group);
      // Prefer actual turn activity over catalog edits or focus changes. Older
      // source metadata may expose only updatedAt, which still provides recency.
      const activityAt = Math.max(0, ...sessions.map((s) => s.activityAt ?? s.updatedAt));
      const location = group.archived
        ? 'Archived in Monitor'
        : isSnoozed(group)
          ? 'Snoozed'
          : isQueued(group)
            ? 'In queue'
            : 'In library';
      const searchText = [
        name,
        project.name,
        project.directory,
        displayDirectory(project.directory, homeDirectory),
        ...sessions.flatMap((s) => [
          s.title,
          s.directory,
          displayDirectory(s.directory, homeDirectory),
        ]),
      ].join(' ');
      return {
        group,
        name,
        project: project.name,
        activityAt,
        location,
        count: sessions.length,
        searchText,
      };
    })
    .sort((a, b) => b.activityAt - a.activityAt || a.group.id.localeCompare(b.group.id));
  return query.trim()
    ? destinations.filter((entry) => matches(entry.searchText))
    : destinations.filter((entry) => entry.activityAt > 0).slice(0, 6);
}
