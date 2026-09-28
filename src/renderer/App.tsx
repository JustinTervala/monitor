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

type Editor =
  | { kind: 'rename'; group: TaskGroup }
  | { kind: 'merge'; source: TaskGroup; target: TaskGroup }
  | { kind: 'add' };
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
  async function open(session: Session) {
    try {
      await window.monitor.openSession(session.id);
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
  const selectedGroup = state.groups.find((g) => g.id === selected);
  const selectedIndex = state.groups.findIndex((g) => g.id === selected);
  const tracked = new Set(state.groups.flatMap((g) => g.sessionIds));
  const available = Object.values(state.sessions)
    .filter((s) => !tracked.has(s.id) && !s.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const matches = (g: TaskGroup) =>
    `${groupName(state, g)} ${projectTag(state, g)} ${groupSessions(state, g)
      .map((s) => s.title)
      .join(' ')}`
      .toLowerCase()
      .includes(search.toLowerCase());
  const reviewCount = state.groups.filter((g) => groupSection(state, g) === 'review').length;
  const runningCount = state.groups.filter((g) => groupSection(state, g) === 'running').length;
  const codex = health.find((h) => h.provider === 'codex');
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
        <div>
          <div className="eyebrow">WORKSTREAMS</div>
          <h1>
            Your queue<span className="heading-dot">.</span>
          </h1>
          <p>
            {reviewCount
              ? `${reviewCount} ${reviewCount === 1 ? 'workstream needs' : 'workstreams need'} you`
              : 'Room to focus'}
            <span className="separator">/</span>
            {runningCount} running
          </p>
        </div>
        <button className="primary" onClick={() => setEditor({ kind: 'add' })}>
          ＋ Add tasks
        </button>
      </header>
      <div className="toolbar">
        <label className="search">
          <span>⌕</span>
          <input
            aria-label="Filter workstreams"
            placeholder="Find a workstream…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <div className="view-toggle" aria-label="Queue view">
          <button className={!priorityView ? 'active' : ''} onClick={() => setPriorityView(false)}>
            By state
          </button>
          <button className={priorityView ? 'active' : ''} onClick={() => setPriorityView(true)}>
            Priority
          </button>
        </div>
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
        <main className="queue">
          <div className="queue-hint">
            Drag a row to group. Drag ⠿ to prioritize.{' '}
            <span>Numbers stay fixed as states change.</span>
          </div>
          {priorityView ? (
            <section className="queue-section">
              <div className="section-heading">
                <h2>Global priority</h2>
                <span>{state.groups.length}</span>
              </div>
              {state.groups.filter(matches).map(row)}
            </section>
          ) : (
            sectionOrder.map((section) => {
              const groups = state.groups.filter(
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
          {!state.groups.length && (
            <div className="empty-queue">
              <h2>Bring your work into view.</h2>
              <p>Add existing Codex tasks to start organizing your queue.</p>
              <button onClick={() => setEditor({ kind: 'add' })}>Browse tasks</button>
            </div>
          )}
        </main>
        {selectedGroup && (
          <aside className="details" aria-label="Workstream details">
            <div className="detail-top">
              <span className="eyebrow">WORKSTREAM · #{selectedIndex + 1}</span>
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
              <button
                title="Increase global priority"
                aria-label="Increase priority"
                disabled={selectedIndex === 0}
                onClick={() =>
                  void command({
                    type: 'move',
                    groupId: selectedGroup.id,
                    targetId: state.groups[selectedIndex - 1].id,
                    placement: 'before',
                  })
                }
              >
                ↑
              </button>
              <button
                title="Decrease global priority"
                aria-label="Decrease priority"
                disabled={selectedIndex === state.groups.length - 1}
                onClick={() =>
                  void command({
                    type: 'move',
                    groupId: selectedGroup.id,
                    targetId: state.groups[selectedIndex + 1].id,
                    placement: 'after',
                  })
                }
              >
                ↓
              </button>
            </div>
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
                <button className="session-link" onClick={() => void open(session)}>
                  {session.title}
                  <span aria-hidden>↗</span>
                </button>
                <p>{session.detail}</p>
                <code title={session.directory || ''}>
                  {session.directory || 'Source directory unavailable'}
                </code>
                <div className="session-actions">
                  <button onClick={() => void open(session)}>
                    Open in {session.provider === 'codex' ? 'Codex' : 'Claude'} ↗
                  </button>
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
            <button
              className="remove-button"
              onClick={() => {
                void command({ type: 'remove', groupId: selectedGroup.id }).then((ok) => {
                  if (ok) setSelected(null);
                });
              }}
            >
              Remove from Monitor
            </button>
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
          available={available}
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
  available,
  close,
  command,
  select,
}: {
  editor: Editor;
  snapshot: Snapshot;
  available: Session[];
  close: () => void;
  command: (c: Command) => Promise<boolean>;
  select: (id: string) => void;
}) {
  const { state } = snapshot;
  const [name, setName] = useState(
    editor.kind === 'rename'
      ? groupName(state, editor.group)
      : editor.kind === 'merge'
        ? editor.target.name || ''
        : '',
  );
  const [project, setProject] = useState(
    editor.kind === 'rename' ? editor.group.projectOverride || '' : '',
  );
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || editor.kind === 'add') return;
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
        <span className="eyebrow">
          {editor.kind === 'add' ? 'EXISTING CODEX SESSIONS' : 'WORKSTREAM'}
        </span>
        <button className="icon-button" onClick={close} aria-label="Close dialog">
          ×
        </button>
      </div>
      <h2>
        {editor.kind === 'add'
          ? 'Add to your queue'
          : editor.kind === 'merge'
            ? 'Name this workstream'
            : 'Edit workstream'}
      </h2>
      {editor.kind === 'add' ? (
        <>
          <p>Start with existing tasks. Group them once they’re in your queue.</p>
          <input
            autoFocus
            aria-label="Search available tasks"
            placeholder="Search tasks or directories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="available-list">
            {available
              .filter((s) =>
                `${s.title} ${s.directory}`.toLowerCase().includes(query.toLowerCase()),
              )
              .map((s) => (
                <div key={s.id}>
                  <span>
                    <strong>{s.title}</strong>
                    <small>{s.directory || 'Project unknown'}</small>
                  </span>
                  <button onClick={() => void command({ type: 'track', sessionId: s.id })}>
                    Add
                  </button>
                </div>
              ))}
            {!available.length && <p>All discovered tasks are already in your queue.</p>}
          </div>
        </>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          {editor.kind === 'merge' && (
            <p>
              Combine “{groupName(state, editor.target)}” and “{groupName(state, editor.source)}”.
              The group keeps the higher priority and the destination’s snooze setting.
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
      )}
    </dialog>
  );
}
