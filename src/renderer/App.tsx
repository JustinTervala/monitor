import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  displayStatus,
  isQueued,
  groupName,
  groupSection,
  groupSessions,
  isSnoozed,
  projectTag,
  sectionLabels,
  sectionOrder,
  statusOrder,
} from '../shared/queue';
import type { Command, MonitorState, Session, Snapshot, TaskGroup } from '../shared/types';
import { ArchiveIcon, LibraryPage } from './LibraryPage';
import { ProviderIcon, RowProviders } from './ProviderIcon';
import { displayDirectory } from './directory';
import { createSearchMatcher } from './search';
import { canResumeInTerminal, resumeCommand } from '../shared/resume';
import { ForkIcon, TaskView } from './TaskView';
import { forkRelatedIds } from '../shared/forks';

type Editor =
  { kind: 'rename'; group: TaskGroup } | { kind: 'merge'; source: TaskGroup; target: TaskGroup };
const statusLabel = {
  review: 'Needs review',
  running: 'Running',
  read: 'Read',
  unknown: 'Unavailable',
};
function tomorrow() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(9, 0, 0, 0);
  return date.getTime();
}
function snoozeLabel(group: TaskGroup) {
  return group.snooze?.until
    ? `Until ${new Date(group.snooze.until).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
    : 'Until you restore it';
}
function counts(state: MonitorState, sessions: Session[]) {
  const values = new Map<string, number>();
  for (const session of sessions) {
    const status = displayStatus(state, session);
    const label =
      session.status === 'unknown'
        ? status === 'unknown'
          ? 'status unavailable'
          : `last seen ${status === 'review' ? 'needing review' : status}`
        : status === 'review'
          ? 'review'
          : status;
    values.set(label, (values.get(label) || 0) + 1);
  }
  return [...values].map(([label, count]) => `${count} ${label}`).join(' · ');
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<{
    id: string;
    initialSection: 'details' | 'family';
  } | null>(null);
  const relatedForks = useMemo(
    () => (snapshot ? forkRelatedIds(snapshot.state) : new Set<string>()),
    [snapshot?.state],
  );
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [drag, setDrag] = useState<{ id: string; mode: 'merge' | 'move' } | null>(null);
  const [drop, setDrop] = useState<{ id: string; placement: 'before' | 'after' } | null>(null);
  const [priorityView, setPriorityView] = useState(false);
  const [page, setPage] = useState<'queue' | 'library' | 'archive'>('queue');
  const [readExpanded, setReadExpanded] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let mounted = true;
    const received = revision.current;
    const off = window.monitor.onSnapshot((value) => {
      revision.current++;
      if (mounted) setSnapshot(value);
    });
    window.monitor
      .snapshot()
      .then((value) => {
        if (mounted && received === revision.current) setSnapshot(value);
      })
      .catch((e) => {
        if (mounted) setError(String(e));
      });
    return () => {
      mounted = false;
      off();
    };
  }, []);
  async function command(value: Command) {
    try {
      const next = await window.monitor.command(value);
      revision.current++;
      setSnapshot(next);
      setError('');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }
  async function attempt(run: () => Promise<unknown>) {
    try {
      await run();
      setError('');
    } catch (e) {
      // Show the main process's own message, not Electron's IPC wrapper.
      setError(String(e).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }
  /** The session's primary destination: its app page, its live iTerm2 tab, or a resumed one. */
  function primary(session: Session): { label: string; run: () => Promise<void> } | null {
    if (session.openable !== false)
      return {
        label: `Open in ${session.provider === 'codex' ? 'Codex' : 'Claude'}`,
        run: () => window.monitor.openSession(session.id),
      };
    if (session.terminalPid)
      return { label: 'Show in iTerm', run: () => window.monitor.showInTerminal(session.id) };
    if (canResumeInTerminal(session))
      return { label: 'Resume in iTerm', run: () => window.monitor.resumeInTerminal(session.id) };
    return null;
  }
  const go = (session: Session) => attempt(async () => primary(session)?.run());
  async function copyResume(session: Session) {
    try {
      await window.monitor.copyResumeCommand(session.id);
      setCopied(session.id);
      setTimeout(() => setCopied((id) => (id === session.id ? null : id)), 2000);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  async function refresh() {
    try {
      await window.monitor.refresh();
    } catch (e) {
      setError(String(e));
    }
  }
  if (!snapshot)
    return (
      <main className="loading">
        <span className="brand-mark">◉</span>
        <h1>Monitor</h1>
        <p>{error || 'Connecting to your workstreams…'}</p>
      </main>
    );
  const { state, health, homeDirectory } = snapshot;
  const activeGroups = state.groups.filter(isQueued);
  const archivedCount = state.groups.filter((g) => g.archived).length;
  const selectedGroup = state.groups.find((g) => g.id === selected);
  const selectedIndex = state.groups.findIndex((g) => g.id === selected);
  const activeIndex = activeGroups.findIndex((g) => g.id === selected);
  const tracked = new Set(state.groups.flatMap((g) => g.sessionIds));
  const matchesSearch = createSearchMatcher(search);
  const matches = (g: TaskGroup) =>
    matchesSearch(
      `${groupName(state, g)} ${projectTag(state, g)} ${groupSessions(state, g)
        .map(
          (s) => `${s.title} ${s.directory || ''} ${displayDirectory(s.directory, homeDirectory)}`,
        )
        .join(' ')}`,
    );
  const reviewCount = activeGroups.filter(
    (g) => !isSnoozed(g) && groupSessions(state, g).some((s) => s.status === 'review'),
  ).length;
  const runningCount = activeGroups.filter(
    (g) =>
      !isSnoozed(g) &&
      groupSessions(state, g).some((s) => s.status === 'running') &&
      !groupSessions(state, g).some((s) => s.status === 'review'),
  ).length;
  const codex = health.find((h) => h.provider === 'codex');
  function navigate(next: 'queue' | 'library' | 'archive') {
    setPage(next);
    setSelectedTask(null);
    setSelected(null);
    setSearch('');
    setDrag(null);
    setDrop(null);
  }
  async function archive(group: TaskGroup) {
    if (await command({ type: 'archive', groupId: group.id }))
      setSelected((id) => (id === group.id ? null : id));
  }
  async function restore(group: TaskGroup, showInQueue = false) {
    if (await command({ type: 'restore', groupId: group.id })) {
      if (showInQueue) {
        navigate('queue');
        setReadExpanded(true);
        setSelected(group.id);
      } else setSelected((id) => (id === group.id ? null : id));
    }
  }
  function beginDrag(event: DragEvent, group: TaskGroup, mode: 'merge' | 'move') {
    event.stopPropagation();
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-monitor-group', group.id);
    setDrag({ id: group.id, mode });
  }
  function over(event: DragEvent, group: TaskGroup) {
    if (!drag || drag.id === group.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const rect = event.currentTarget.getBoundingClientRect();
    setDrop({
      id: group.id,
      placement: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after',
    });
  }
  function dropped(event: DragEvent, target: TaskGroup) {
    event.preventDefault();
    const source = state.groups.find((g) => g.id === drag?.id);
    if (source && source.id !== target.id) {
      if (drag?.mode === 'move')
        void command({
          type: 'move',
          groupId: source.id,
          targetId: target.id,
          placement: drop?.placement || 'before',
        });
      else if (target.name)
        void command({
          type: 'merge',
          sourceId: source.id,
          targetId: target.id,
          name: target.name,
        }).then((merged) => {
          if (merged) setSelected(target.id);
        });
      else setEditor({ kind: 'merge', source, target });
    }
    setDrag(null);
    setDrop(null);
  }
  function openAction(group: TaskGroup) {
    const members = groupSessions(state, group);
    const byAttention = members.toSorted(
      (a, b) =>
        statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status) || b.updatedAt - a.updatedAt,
    );
    const nextTask = byAttention.find((session) => primary(session));
    const familyTask = byAttention.find((session) => relatedForks.has(session.id));
    const destination = nextTask && primary(nextTask);
    return (
      <>
        {familyTask && (
          <button
            className="open-row-action family-shortcut"
            aria-label={`View fork family: ${familyTask.title}`}
            title={`View fork family: ${familyTask.title}`}
            onClick={() => viewTask(familyTask.id, 'family')}
          >
            <ForkIcon />
          </button>
        )}
        {destination && (
          <button
            className="open-row-action"
            data-testid="open-task"
            aria-label={`${destination.label}: ${nextTask.title}`}
            title={`${destination.label}: ${nextTask.title}`}
            onClick={() => void go(nextTask)}
          >
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14 3h7v7M21 3L11 13M10 3H3v18h18v-7" />
            </svg>
          </button>
        )}
      </>
    );
  }
  function viewTask(id: string, initialSection: 'details' | 'family' = 'details') {
    setSelectedTask({ id, initialSection });
  }
  function selectRow(group: TaskGroup) {
    const members = groupSessions(state, group);
    if (members.length === 1) {
      setSelected(null);
      viewTask(members[0].id);
    } else setSelected(group.id);
  }
  function row(group: TaskGroup) {
    const section = groupSection(state, group),
      sessions = groupSessions(state, group);
    const dropClass =
      drop?.id === group.id
        ? drag?.mode === 'merge'
          ? ' merge-target'
          : ` insert-${drop.placement}`
        : '';
    return (
      <div
        key={group.id}
        data-testid="group-row"
        data-group-id={group.id}
        className={`group-row${selected === group.id ? ' selected' : ''}${dropClass}`}
        draggable
        onDragStart={(event) => beginDrag(event, group, 'merge')}
        onDragEnd={() => {
          setDrag(null);
          setDrop(null);
        }}
        onDragOver={(event) => over(event, group)}
        onDrop={(event) => dropped(event, group)}
      >
        <button
          className="grip"
          title="Drag to change priority"
          aria-label={`Reorder ${groupName(state, group)}`}
          draggable
          onDragStart={(event) => beginDrag(event, group, 'move')}
        >
          ⠿
        </button>
        <span className="rank" title="Global priority">
          {state.groups.indexOf(group) + 1}
        </span>
        <button
          className="row-select"
          aria-label={
            sessions.length === 1
              ? `View task: ${sessions[0].title}${group.name ? ` · ${group.name}` : ''}`
              : undefined
          }
          title={sessions.length === 1 ? 'View task details' : 'View group tasks'}
          onClick={() => selectRow(group)}
        >
          <span
            className={`status-dot ${section}${sessions.some((s) => s.status === 'unknown') ? ' stale' : ''}`}
            aria-hidden="true"
          />
          <RowProviders providers={sessions.map((session) => session.provider)} />
          <span className="row-name">
            {groupName(state, group)}
            <span className="row-meta">
              {isSnoozed(group) ? snoozeLabel(group) : counts(state, sessions)}
              {sessions.some(
                (s) => s.status === 'unknown' && displayStatus(state, s) !== 'unknown',
              ) && <span className="stale-label"> · Status unavailable</span>}
            </span>
          </span>
          <span className="project-tag">{projectTag(state, group)}</span>
          <span className="task-count" title={`${sessions.length} tasks`}>
            {sessions.length}
          </span>
        </button>
        {openAction(group)}
        <button
          className="quiet archive-row-action"
          title="Archive workstream"
          aria-label={`Archive ${groupName(state, group)}`}
          onClick={() => void archive(group)}
        >
          <ArchiveIcon />
        </button>
      </div>
    );
  }
  return (
    <div className="app-shell">
      <div className="titlebar">
        <span>MONITOR</span>
        <span>YOUR ATTENTION, IN ORDER</span>
      </div>
      <header className="page-header">
        <h1 className="sr-only">
          {page === 'queue' ? 'Your queue.' : page === 'library' ? 'Library.' : 'Archived.'}
        </h1>
        <nav className="page-nav" aria-label="Monitor pages">
          <button
            aria-current={page === 'queue' ? 'page' : undefined}
            onClick={() => navigate('queue')}
          >
            Queue <span>{activeGroups.length}</span>
          </button>
          <button
            aria-current={page === 'library' ? 'page' : undefined}
            onClick={() => navigate('library')}
          >
            Library <span>{state.groups.length}</span>
          </button>
          <button
            aria-current={page === 'archive' ? 'page' : undefined}
            onClick={() => navigate('archive')}
          >
            <ArchiveIcon /> Archived <span>{archivedCount}</span>
          </button>
        </nav>
        {selectedTask ? (
          <p>Task view</p>
        ) : page === 'queue' ? (
          <p>
            {reviewCount} need review
            <span className="separator">·</span>
            {runningCount} running
          </p>
        ) : (
          <p>
            {page === 'library'
              ? `${state.groups.length} workstreams`
              : `${archivedCount} archived workstreams`}
          </p>
        )}
      </header>
      {!selectedTask && (
        <div className="toolbar">
          <label className="search">
            <span>⌕</span>
            <input
              aria-label="Filter workstreams"
              placeholder={
                page === 'queue'
                  ? 'Find a workstream…'
                  : page === 'library'
                    ? 'Search all tasks…'
                    : 'Search the archive…'
              }
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          {page === 'queue' ? (
            <div className="view-toggle" aria-label="Queue view">
              <button
                className={!priorityView ? 'active' : ''}
                onClick={() => setPriorityView(false)}
              >
                By state
              </button>
              <button
                className={priorityView ? 'active' : ''}
                onClick={() => setPriorityView(true)}
              >
                Priority
              </button>
            </div>
          ) : (
            <span className="archive-sort">Project · Recent activity</span>
          )}
          <button
            className={`quiet notification-toggle ${state.notifications ? '' : 'muted'}`}
            title="Monitor completion notifications"
            aria-pressed={state.notifications}
            onClick={() => void command({ type: 'notifications', enabled: !state.notifications })}
          >
            {state.notifications ? '◉ Notifications on' : '○ Notifications off'}
          </button>
        </div>
      )}
      {error && (
        <div role="alert" className="error-banner">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {selectedTask ? (
        <TaskView
          state={state}
          sessionId={selectedTask.id}
          initialSection={selectedTask.initialSection}
          homeDirectory={homeDirectory}
          backLabel={page === 'queue' ? 'Queue' : page === 'library' ? 'Library' : 'Archived'}
          back={() => setSelectedTask(null)}
          select={(id) => setSelectedTask({ ...selectedTask, id })}
          viewGroup={(group) => {
            setPage(group.archived ? 'archive' : isQueued(group) ? 'queue' : 'library');
            setSearch('');
            setSelected(group.id);
            setSelectedTask(null);
            setReadExpanded(true);
          }}
          assign={(sessionId, targetId) => command({ type: 'assign', sessionId, targetId })}
          detach={(groupId, sessionId) => command({ type: 'detach', groupId, sessionId })}
          open={(session) => void go(session)}
          primaryLabel={(session) => primary(session)?.label || null}
          actions={(session) => (
            <>
              {session.openable !== false && session.terminalPid && (
                <button
                  onClick={() => void attempt(() => window.monitor.showInTerminal(session.id))}
                >
                  Show in iTerm
                </button>
              )}
              {session.openable !== false && canResumeInTerminal(session) && (
                <button
                  onClick={() => void attempt(() => window.monitor.resumeInTerminal(session.id))}
                >
                  Resume in iTerm
                </button>
              )}
              {resumeCommand(session) && (
                <button onClick={() => void copyResume(session)}>
                  {copied === session.id ? 'Copied ✓' : 'Copy resume command'}
                </button>
              )}
            </>
          )}
        />
      ) : (
        <div className={`workspace ${selectedGroup ? 'with-details' : ''}`}>
          {page !== 'queue' ? (
            <LibraryPage
              homeDirectory={homeDirectory}
              key={page}
              mode={page}
              openAction={openAction}
              state={state}
              search={search}
              matches={matches}
              selected={selected}
              select={(id) => {
                const group = state.groups.find((g) => g.id === id);
                if (group) selectRow(group);
              }}
              restore={(group) => void restore(group)}
            />
          ) : (
            <main className="queue">
              {priorityView ? (
                <section className="queue-section">
                  <div className="section-heading">
                    <h2>Global priority</h2>
                    <span>{activeGroups.length}</span>
                  </div>
                  {activeGroups.filter(matches).map(row)}
                </section>
              ) : (
                sectionOrder.map((section) => {
                  const groups = activeGroups.filter(
                    (g) => groupSection(state, g) === section && matches(g),
                  );
                  if (!groups.length && section !== 'review' && section !== 'running') return null;
                  const expanded = section !== 'read' || readExpanded || Boolean(search.trim());
                  return (
                    <section
                      className={`queue-section section-${section}`}
                      key={section}
                      aria-label={section === 'unknown' ? undefined : sectionLabels[section]}
                    >
                      {section !== 'unknown' && (
                        <div className="section-heading">
                          <span className={`status-dot ${section}`} aria-hidden="true" />
                          <h2>
                            {section === 'read' ? (
                              <button
                                className="section-toggle"
                                aria-expanded={expanded}
                                aria-controls="read-workstreams"
                                onClick={() => setReadExpanded((value) => !value)}
                              >
                                <svg
                                  className="section-chevron"
                                  width="12"
                                  height="12"
                                  viewBox="0 0 12 12"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="1.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  aria-hidden="true"
                                  focusable="false"
                                >
                                  <path d="M4.5 3 7.5 6 4.5 9" />
                                </svg>
                                Read
                              </button>
                            ) : (
                              sectionLabels[section]
                            )}
                          </h2>
                          <span>{groups.length}</span>
                        </div>
                      )}
                      <div
                        id={section === 'read' ? 'read-workstreams' : undefined}
                        hidden={!expanded}
                      >
                        {groups.length ? (
                          groups.map(row)
                        ) : (
                          <div className="empty-section">
                            {search
                              ? 'No matching workstreams'
                              : section === 'review'
                                ? 'Nothing waiting for your attention.'
                                : 'No workstreams running right now.'}
                          </div>
                        )}
                      </div>
                    </section>
                  );
                })
              )}
              {!activeGroups.length && (
                <div className="empty-queue">
                  <h2>
                    {state.groups.length
                      ? 'Your queue is clear.'
                      : 'Your tasks appear automatically.'}
                  </h2>
                  <p>
                    {state.groups.length
                      ? 'Find older work in Library, or start a new task in Codex or Claude.'
                      : 'Open Codex and start a task. It will appear here on the next refresh.'}
                  </p>
                </div>
              )}
            </main>
          )}
          {selectedGroup && (
            <aside className="details" aria-label="Workstream details">
              <div className="detail-top">
                <span className="eyebrow">
                  {selectedGroup.archived
                    ? 'ARCHIVED WORKSTREAM'
                    : isQueued(selectedGroup)
                      ? `WORKSTREAM · #${selectedIndex + 1}`
                      : 'LIBRARY WORKSTREAM'}
                </span>
                <button
                  className="icon-button"
                  aria-label="Close details"
                  onClick={() => setSelected(null)}
                >
                  ×
                </button>
              </div>
              <h2>{groupName(state, selectedGroup)}</h2>
              <span className="project-tag">{projectTag(state, selectedGroup)}</span>
              <div className="detail-actions">
                <button onClick={() => setEditor({ kind: 'rename', group: selectedGroup })}>
                  Edit group
                </button>
                {isQueued(selectedGroup) && (
                  <>
                    <button
                      title="Increase global priority"
                      aria-label="Increase priority"
                      disabled={activeIndex === 0}
                      onClick={() =>
                        void command({
                          type: 'move',
                          groupId: selectedGroup.id,
                          targetId: activeGroups[activeIndex - 1].id,
                          placement: 'before',
                        })
                      }
                    >
                      ↑
                    </button>
                    <button
                      title="Decrease global priority"
                      aria-label="Decrease priority"
                      disabled={activeIndex === activeGroups.length - 1}
                      onClick={() =>
                        void command({
                          type: 'move',
                          groupId: selectedGroup.id,
                          targetId: activeGroups[activeIndex + 1].id,
                          placement: 'after',
                        })
                      }
                    >
                      ↓
                    </button>
                  </>
                )}
              </div>
              <div className="member-heading">
                <h3>Tasks</h3>
                <span>{selectedGroup.sessionIds.length}</span>
              </div>
              {groupSessions(state, selectedGroup).map((session) => (
                <div className="session-card" key={session.id} data-testid="session-card">
                  <button
                    className="session-select"
                    aria-label={`View task: ${session.title}`}
                    onClick={() => viewTask(session.id)}
                  >
                    <span className="session-status">
                      <span className={`status-dot ${session.status}`} aria-hidden="true" />
                      {session.status === 'unknown' && displayStatus(state, session) !== 'unknown'
                        ? `Last seen ${statusLabel[displayStatus(state, session)].toLowerCase()}`
                        : statusLabel[session.status]}
                      <span className="provider-name">
                        <ProviderIcon provider={session.provider} />
                        {session.provider}
                      </span>
                    </span>
                    <strong className="session-title">{session.title}</strong>
                    <span className="session-summary">{session.detail}</span>
                    <code title={session.directory || ''}>
                      {displayDirectory(session.directory, homeDirectory) ||
                        'Source directory unavailable'}
                    </code>
                    <span className="session-details-link">
                      View task details <span aria-hidden="true">→</span>
                    </span>
                  </button>
                  <div className="session-actions">
                    {relatedForks.has(session.id) && (
                      <button
                        className="quiet family-shortcut"
                        aria-label={`View fork family: ${session.title}`}
                        title={`View fork family: ${session.title}`}
                        onClick={() => viewTask(session.id, 'family')}
                      >
                        <ForkIcon />
                      </button>
                    )}
                    {primary(session) && (
                      <button onClick={() => void go(session)}>{primary(session)!.label} ↗</button>
                    )}
                    {session.openable !== false && session.terminalPid && (
                      <button
                        className="quiet"
                        onClick={() =>
                          void attempt(() => window.monitor.showInTerminal(session.id))
                        }
                      >
                        Show in iTerm
                      </button>
                    )}
                    {session.openable !== false && canResumeInTerminal(session) && (
                      <button
                        className="quiet"
                        onClick={() =>
                          void attempt(() => window.monitor.resumeInTerminal(session.id))
                        }
                      >
                        Resume in iTerm
                      </button>
                    )}
                    {resumeCommand(session) && (
                      <button
                        className="quiet"
                        title={`${resumeCommand(session)}\nResume after the task has stopped in its current app or terminal.`}
                        onClick={() => void copyResume(session)}
                      >
                        {copied === session.id ? 'Copied ✓' : 'Copy resume command'}
                      </button>
                    )}
                    {selectedGroup.sessionIds.length > 1 && (
                      <button
                        className="quiet"
                        onClick={() =>
                          void command({
                            type: 'detach',
                            groupId: selectedGroup.id,
                            sessionId: session.id,
                          })
                        }
                      >
                        Detach
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {!isQueued(selectedGroup) ? (
                <div className="archive-control">
                  <button className="primary" onClick={() => void restore(selectedGroup, true)}>
                    {selectedGroup.archived ? 'Restore to queue' : 'Add to queue'}
                  </button>
                  {!selectedGroup.archived && (
                    <button
                      className="archive-workstream"
                      onClick={() => void archive(selectedGroup)}
                    >
                      <ArchiveIcon /> Archive workstream
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="snooze-control">
                    <label htmlFor="group-snooze">Defer this workstream</label>
                    <select
                      id="group-snooze"
                      aria-label="Snooze workstream"
                      value={isSnoozed(selectedGroup) ? 'current' : 'active'}
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === 'active')
                          void command({ type: 'unsnooze', groupId: selectedGroup.id });
                        else if (value !== 'current')
                          void command({
                            type: 'snooze',
                            groupId: selectedGroup.id,
                            until:
                              value === 'hour'
                                ? Date.now() + 3600000
                                : value === 'tomorrow'
                                  ? tomorrow()
                                  : null,
                          });
                      }}
                    >
                      <option value="active">Active</option>
                      {isSnoozed(selectedGroup) && (
                        <option value="current">{snoozeLabel(selectedGroup)}</option>
                      )}
                      <option value="hour">Snooze for 1 hour</option>
                      <option value="tomorrow">Tomorrow at 9 AM</option>
                      <option value="manual">Until I restore it</option>
                    </select>
                  </div>
                  <button
                    className="archive-workstream"
                    onClick={() => void archive(selectedGroup)}
                  >
                    <ArchiveIcon /> Archive workstream
                  </button>
                </>
              )}
            </aside>
          )}
        </div>
      )}
      <footer>
        <div className="connection" title={codex?.message}>
          <span
            className={`connection-dot ${codex?.state === 'live' ? 'connected' : ''}`}
            aria-hidden="true"
          />
          <span>
            {codex?.state === 'live'
              ? 'Codex connected'
              : codex?.state === 'connecting'
                ? 'Connecting to Codex'
                : 'Codex observer unavailable'}
          </span>
        </div>
        <span className="footer-note">
          {codex?.state !== 'live' ? codex?.message : `${tracked.size} tasks`}
        </span>
        <button className="quiet" onClick={() => void refresh()}>
          Refresh ↻
        </button>
      </footer>
      {editor && (
        <EditorDialog
          editor={editor}
          snapshot={snapshot}
          close={() => setEditor(null)}
          command={command}
          select={setSelected}
        />
      )}
    </div>
  );
}

function EditorDialog({
  editor,
  snapshot,
  close,
  command,
  select,
}: {
  editor: Editor;
  snapshot: Snapshot;
  close: () => void;
  command: (c: Command) => Promise<boolean>;
  select: (id: string) => void;
}) {
  const { state } = snapshot;
  const [name, setName] = useState(
    editor.kind === 'rename' ? groupName(state, editor.group) : editor.target.name || '',
  );
  const [project, setProject] = useState(
    editor.kind === 'rename' ? editor.group.projectOverride || '' : '',
  );
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    const value: Command =
      editor.kind === 'merge'
        ? { type: 'merge', sourceId: editor.source.id, targetId: editor.target.id, name }
        : { type: 'rename', groupId: editor.group.id, name, projectOverride: project || null };
    if (await command(value)) {
      select(editor.kind === 'merge' ? editor.target.id : editor.group.id);
      close();
    } else
      setDialogError(
        'Could not save this group. It may have changed; close this dialog and try again.',
      );
    setBusy(false);
  }
  return (
    <dialog ref={dialog} onCancel={close} className="editor-dialog">
      <div className="dialog-top">
        <span className="eyebrow">WORKSTREAM</span>
        <button className="icon-button" onClick={close} aria-label="Close dialog">
          ×
        </button>
      </div>
      <h2>{editor.kind === 'merge' ? 'Name this workstream' : 'Edit workstream'}</h2>
      <form onSubmit={(event) => void submit(event)}>
        {editor.kind === 'merge' && (
          <p>
            Combine “{groupName(state, editor.target)}” and “{groupName(state, editor.source)}”. The
            group keeps the higher priority and the destination’s snooze setting.
          </p>
        )}
        <label>
          Group name
          <input
            autoFocus
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Billing rollout"
          />
        </label>
        {editor.kind === 'rename' && (
          <label>
            Project tag
            <input
              maxLength={80}
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="Automatic from source directory"
            />
            <small>Leave empty to infer from the group’s source directories.</small>
          </label>
        )}
        {dialogError && <p role="alert">{dialogError}</p>}
        <div className="dialog-actions">
          <button type="button" onClick={close}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !name.trim()} type="submit">
            {editor.kind === 'merge' ? 'Create group' : 'Save changes'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
