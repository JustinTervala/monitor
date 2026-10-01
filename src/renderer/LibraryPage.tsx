import { useState, type ReactNode } from 'react';
import {
  archiveProjects,
  libraryProjects,
  isQueued,
  groupName,
  groupSessions,
  groupUpdatedAt,
} from '../shared/queue';
import type { MonitorState, TaskGroup } from '../shared/types';
import { RowProviders } from './ProviderIcon';

export function ArchiveIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M4 8v12h16V8M3 4h18v4H3zM9 12h6" />
    </svg>
  );
}

function activityDate(time: number) {
  if (!time) return 'Date unavailable';
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
  });
}

export function LibraryPage({
  mode,
  openAction,
  state,
  search,
  matches,
  selected,
  select,
  restore,
}: {
  mode: 'library' | 'archive';
  openAction: (group: TaskGroup) => ReactNode;
  state: MonitorState;
  search: string;
  matches: (group: TaskGroup) => boolean;
  selected: string | null;
  select: (id: string) => void;
  restore: (group: TaskGroup) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [limits, setLimits] = useState<Record<string, number>>({});
  const projects =
    mode === 'archive' ? archiveProjects(state, matches) : libraryProjects(state, matches);
  return (
    <main
      className="queue archive-page"
      aria-label={mode === 'archive' ? 'Archived workstreams' : 'Task library'}
    >
      {!projects.length && (
        <div className="empty-queue">
          <ArchiveIcon />
          <h2>
            {search
              ? 'No matching workstreams'
              : mode === 'archive'
                ? 'A home for work you’ve put away.'
                : 'Your tasks appear automatically.'}
          </h2>
          <p>
            {search
              ? 'Try a different name, task, or project.'
              : mode === 'archive'
                ? 'Archive a workstream to keep it here.'
                : 'Start a task in Codex or Claude to see it here.'}
          </p>
        </div>
      )}
      {projects.map((project) => {
        const expanded = Boolean(search) || !collapsed.has(project.key);
        const panelId = `${mode}-${encodeURIComponent(project.key)}`;
        const limit = limits[project.key] || 20;
        return (
          <section key={project.key} className="archive-project" data-testid={`${mode}-project`}>
            <h2>
              <button
                className="project-heading"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => {
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (expanded) next.add(project.key);
                    else next.delete(project.key);
                    return next;
                  });
                }}
              >
                <span
                  className={`project-chevron ${expanded ? 'expanded' : ''}`}
                  aria-hidden="true"
                >
                  ›
                </span>
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  aria-hidden="true"
                >
                  <path d="M3 7V5h6l2 2h10v13H3z" />
                </svg>
                <span className="project-heading-name">
                  {project.name}
                  <small>
                    {project.directory || (project.key.startsWith('name:') ? 'Custom project' : '')}
                  </small>
                </span>
                <span className="project-total">{project.groups.length}</span>
              </button>
            </h2>
            <div id={panelId} hidden={!expanded}>
              {(mode === 'library'
                ? expanded
                  ? project.groups.slice(0, limit)
                  : []
                : project.groups
              ).map((group) => {
                const sessions = groupSessions(state, group);
                const updatedAt = groupUpdatedAt(state, group);
                const name = groupName(state, group);
                const queued = isQueued(group);
                return (
                  <div
                    key={group.id}
                    data-testid={`${mode}-row`}
                    data-group-id={group.id}
                    className={`archive-row${selected === group.id ? ' selected' : ''}`}
                  >
                    <button className="row-select" onClick={() => select(group.id)}>
                      <RowProviders providers={sessions.map((session) => session.provider)} />
                      <span className="row-name">
                        {name}
                        <span className="row-meta">
                          {mode === 'library' &&
                            `${group.archived ? 'Archived' : queued ? 'In queue' : 'In library'} · `}
                          {sessions.length} {sessions.length === 1 ? 'task' : 'tasks'}
                        </span>
                      </span>
                      <time
                        className="activity-date"
                        dateTime={updatedAt ? new Date(updatedAt).toISOString() : undefined}
                        title={
                          updatedAt
                            ? `Last task activity: ${new Date(updatedAt).toLocaleString()}`
                            : 'Source activity date unavailable'
                        }
                      >
                        {activityDate(updatedAt)}
                      </time>
                    </button>
                    {mode === 'library' && openAction(group)}
                    {!queued && (
                      <button
                        className="quiet restore-row"
                        aria-label={`${group.archived ? 'Restore' : 'Add'} ${name} to queue`}
                        onClick={() => restore(group)}
                      >
                        {group.archived ? 'Restore' : 'Add to queue'}
                      </button>
                    )}
                  </div>
                );
              })}
              {mode === 'library' && expanded && project.groups.length > limit && (
                <button
                  className="quiet library-more"
                  onClick={() =>
                    setLimits((previous) => ({ ...previous, [project.key]: limit + 50 }))
                  }
                >
                  Show more · {project.groups.length - limit} remaining
                </button>
              )}
            </div>
          </section>
        );
      })}
    </main>
  );
}
