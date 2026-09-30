import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  groupName,
  groupSection,
  groupSessions,
  isSnoozed,
  projectTag,
  sectionLabels,
  sectionOrder,
} from '../shared/queue';
import type { Command, Session, Snapshot, TaskGroup } from '../shared/types';
import { ArchiveIcon, ArchivePage } from './ArchivePage';
import { resumeCommand } from '../shared/resume';

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
function counts(sessions: Session[]) {
  return ['review', 'running', 'unknown', 'read']
    .flatMap((status) => {
      const count = sessions.filter((s) => s.status === status).length;
      return count
        ? [
            `${count} ${status === 'review' ? 'review' : status === 'unknown' ? 'unavailable' : status}`,
          ]
        : [];
    })
    .join(' · ');
}

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [drag, setDrag] = useState<{ id: string; mode: 'merge' | 'move' } | null>(null);
  const [drop, setDrop] = useState<{ id: string; placement: 'before' | 'after' } | null>(null);
  const [priorityView, setPriorityView] = useState(false);
  const [page, setPage] = useState<'queue' | 'archive'>('queue');
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
    if (resumeCommand(session))
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
  const { state, health } = snapshot;
  const activeGroups = state.groups.filter((g) => !g.archived);
  const archivedCount = state.groups.length - activeGroups.length;
  const selectedGroup = state.groups.find((g) => g.id === selected);
  const selectedIndex = state.groups.findIndex((g) => g.id === selected);
  const activeIndex = activeGroups.findIndex((g) => g.id === selected);
  const tracked = new Set(state.groups.flatMap((g) => g.sessionIds));
  const matches = (g: TaskGroup) =>
    `${groupName(state, g)} ${projectTag(state, g)} ${groupSessions(state, g)
      .map((s) => `${s.title} ${s.directory || ''}`)
      .join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase());
  const reviewCount = activeGroups.filter((g) => groupSection(state, g) === 'review').length;
  const runningCount = activeGroups.filter((g) => groupSection(state, g) === 'running').length;
  const codex = health.find((h) => h.provider === 'codex');
  function navigate(next: 'queue' | 'archive') {
    setPage(next);
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
      else setEditor({ kind: 'merge', source, target });
    }
    setDrag(null);
    setDrop(null);
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
        <button className="row-select" onClick={() => setSelected(group.id)}>
          <span className={`status-dot ${section}`} />
          <span className="row-name">
            {groupName(state, group)}
            <span className="row-meta">
              {isSnoozed(group) ? snoozeLabel(group) : counts(sessions)}
            </span>
          </span>
          <span className="project-tag">{projectTag(state, group)}</span>
          <span className="task-count" title={`${sessions.length} tasks`}>
            {sessions.length}
            <span>↗</span>
          </span>
        </button>
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
      <nav className="page-nav" aria-label="Monitor pages">
        <button
          aria-current={page === 'queue' ? 'page' : undefined}
          onClick={() => navigate('queue')}
        >
          Queue <span>{activeGroups.length}</span>
        </button>
        <button
          aria-current={page === 'archive' ? 'page' : undefined}
          onClick={() => navigate('archive')}
        >
          <ArchiveIcon /> Archived <span>{archivedCount}</span>
        </button>
      </nav>
      <header className="page-header">
        <div>
          <div className="eyebrow">{page === 'queue' ? 'WORKSTREAMS' : 'PROJECTS & HISTORY'}</div>
          <h1>
            {page === 'queue' ? 'Your queue' : 'Archived'}
            <span className="heading-dot">.</span>
          </h1>
          {page === 'queue' ? (
            <p>
              {reviewCount
                ? `${reviewCount} ${reviewCount === 1 ? 'workstream needs' : 'workstreams need'} you`
                : 'Room to focus'}
              <span className="separator">/</span>
              {runningCount} running
            </p>
          ) : (
            <p>
              {archivedCount} {archivedCount === 1 ? 'workstream' : 'workstreams'} put away{' '}
              <span className="separator">/</span> Ready when you need them
            </p>
          )}
        </div>
      </header>
      <div className="toolbar">
        <label className="search">
          <span>⌕</span>
          <input
            aria-label="Filter workstreams"
            placeholder={page === 'queue' ? 'Find a workstream…' : 'Search the archive…'}
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
            <button className={priorityView ? 'active' : ''} onClick={() => setPriorityView(true)}>
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
      {error && (
        <div role="alert" className="error-banner">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      <div className={`workspace ${selectedGroup ? 'with-details' : ''}`}>
        {page === 'archive' ? (
          <ArchivePage
            state={state}
            search={search}
            matches={matches}
            selected={selected}
            select={setSelected}
            restore={(group) => void restore(group)}
          />
        ) : (
          <main className="queue">
            <div className="queue-hint">
              Drag a row to group. Drag ⠿ to prioritize.{' '}
              <span>Numbers stay fixed as states change.</span>
            </div>
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
                return (
                  <section
                    className={`queue-section section-${section}`}
                    key={section}
                    aria-label={sectionLabels[section]}
                  >
                    <div className="section-heading">
                      <span className={`status-dot ${section}`} />
                      <h2>{sectionLabels[section]}</h2>
                      <span>{groups.length}</span>
                    </div>
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
                  </section>
                );
              })
            )}
            {!activeGroups.length && (
              <div className="empty-queue">
                <h2>
                  {archivedCount ? 'Your queue is clear.' : 'Your tasks appear automatically.'}
                </h2>
                <p>
                  {archivedCount
                    ? 'Restore an archived workstream, or start a new task in Codex.'
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
                  : `WORKSTREAM · #${selectedIndex + 1}`}
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
              {!selectedGroup.archived && (
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
            {selectedGroup.archived ? (
              <div className="archive-control">
                <button className="primary" onClick={() => void restore(selectedGroup, true)}>
                  Restore to queue
                </button>
                <p>
                  Archived in Monitor. Tasks stay in their source apps, and Monitor notifications
                  are paused.
                </p>
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
                  <p>Tasks keep working. Monitor notifications pause for this group.</p>
                </div>
                <button className="archive-workstream" onClick={() => void archive(selectedGroup)}>
                  <ArchiveIcon /> Archive workstream
                </button>
              </>
            )}
            <div className="member-heading">
              <h3>Tasks</h3>
              <span>{selectedGroup.sessionIds.length}</span>
            </div>
            {groupSessions(state, selectedGroup).map((session) => (
              <div className="session-card" key={session.id} data-testid="session-card">
                <div className="session-status">
                  <span className={`status-dot ${session.status}`} />
                  {statusLabel[session.status]}
                  <span className="provider-name">{session.provider}</span>
                </div>
                {primary(session) ? (
                  <button className="session-link" onClick={() => void go(session)}>
                    {session.title}
                    <span aria-hidden>↗</span>
                  </button>
                ) : (
                  <span className="session-link">{session.title}</span>
                )}
                <p>{session.detail}</p>
                <code title={session.directory || ''}>
                  {session.directory || 'Source directory unavailable'}
                </code>
                <div className="session-actions">
                  {primary(session) && (
                    <button onClick={() => void go(session)}>{primary(session)!.label} ↗</button>
                  )}
                  {session.openable !== false && session.terminalPid && (
                    <button
                      className="quiet"
                      onClick={() => void attempt(() => window.monitor.showInTerminal(session.id))}
                    >
                      Show in iTerm
                    </button>
                  )}
                  {resumeCommand(session) && (
                    <button
                      className="quiet"
                      title={`${resumeCommand(session)}${session.openable === false ? '' : '\nAvoid resuming while Claude desktop has this session running.'}`}
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
            <p className="source-note">
              Task states and read receipts come from the source app. An unavailable task may need
              to be opened there before it exposes live state.
            </p>
          </aside>
        )}
      </div>
      <footer>
        <div className="connection" title={codex?.message}>
          <span className={`connection-dot ${codex?.state === 'live' ? 'connected' : ''}`} />
          <span>
            {codex?.state === 'live'
              ? 'Codex connected'
              : codex?.state === 'connecting'
                ? 'Connecting to Codex'
                : 'Codex observer unavailable'}
          </span>
        </div>
        <span className="footer-note">
          {codex?.state !== 'live' ? codex?.message : `${tracked.size} tasks · local observation`}
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
