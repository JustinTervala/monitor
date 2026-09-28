import { useState } from 'react';
import { archiveProjects, groupName, groupSessions, groupUpdatedAt } from '../shared/queue';
import type { MonitorState, TaskGroup } from '../shared/types';

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

export function ArchivePage({
  state,
  search,
  matches,
  selected,
  select,
  restore,
}: {
  state: MonitorState;
  search: string;
  matches: (group: TaskGroup) => boolean;
  selected: string | null;
  select: (id: string) => void;
  restore: (group: TaskGroup) => void;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const projects = archiveProjects(state, matches);
  return (
    <main className="queue archive-page" aria-label="Archived workstreams">
      <div className="queue-hint">
        By project, most recent activity first. Restore a workstream to bring it back to your queue.
      </div>
      {!projects.length && (
        <div className="empty-queue">
          <ArchiveIcon />
          <h2>{search ? 'No matching workstreams' : 'A home for work you’ve put away.'}</h2>
          <p>
            {search
              ? 'Try a different name, task, or project.'
              : 'Archive a workstream from your queue to keep it here. Its tasks stay in Codex.'}
          </p>
        </div>
      )}
      {projects.map((project) => {
        const expanded = Boolean(search) || !collapsed.has(project.key);
        const panelId = `archive-${encodeURIComponent(project.key)}`;
        return (
          <section key={project.key} className="archive-project" data-testid="archive-project">
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
              {project.groups.map((group) => {
                const sessions = groupSessions(state, group);
                const updatedAt = groupUpdatedAt(state, group);
                const name = groupName(state, group);
                return (
                  <div
                    key={group.id}
                    data-testid="archive-row"
                    data-group-id={group.id}
                    className={`archive-row${selected === group.id ? ' selected' : ''}`}
                  >
                    <button className="row-select" onClick={() => select(group.id)}>
                      <span className="row-name">
                        {name}
                        <span className="row-meta">
                          {sessions.length} {sessions.length === 1 ? 'task' : 'tasks'} ·{' '}
                          {[
                            ...new Set(
                              sessions.map((s) => (s.provider === 'codex' ? 'Codex' : 'Claude')),
                            ),
                          ].join(' + ')}
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
                    <button
                      className="quiet restore-row"
                      aria-label={`Restore ${name} to queue`}
                      onClick={() => restore(group)}
                    >
                      Restore
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}
