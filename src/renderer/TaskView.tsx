import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { forkDescendants, forkFamily, forkPath, visibleForks } from '../shared/forks';
import { displayStatus, groupName, isQueued, isSnoozed } from '../shared/queue';
import type { MonitorState, Session, TaskGroup } from '../shared/types';
import { displayDirectory } from './directory';
import { GroupPicker } from './GroupPicker';
import { ProviderIcon } from './ProviderIcon';

const labels = {
  read: 'Read',
  running: 'Running',
  review: 'Needs review',
  unknown: 'Status unavailable',
};
function stateLabel(state: MonitorState, session: Session) {
  const status = displayStatus(state, session);
  return session.status === 'unknown' && status !== 'unknown'
    ? `Last seen ${labels[status].toLowerCase()} · Status unavailable`
    : labels[session.status];
}
function age(time: number) {
  if (!time) return 'Time unavailable';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} hr ago`;
  return new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function location(group: TaskGroup) {
  return group.archived
    ? 'Archived in Monitor'
    : isSnoozed(group)
      ? 'Snoozed'
      : isQueued(group)
        ? 'In queue'
        : 'In library';
}

export function ForkIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <circle cx="6" cy="5" r="2.5" />
      <circle cx="18" cy="5" r="2.5" />
      <circle cx="6" cy="19" r="2.5" />
      <path d="M6 7.5v9M18 7.5c0 6-12 3-12 9" />
    </svg>
  );
}

export function TaskView({
  state,
  sessionId,
  initialSection,
  homeDirectory,
  backLabel,
  back,
  select,
  viewGroup,
  assign,
  detach,
  open,
  primaryLabel,
  actions,
}: {
  state: MonitorState;
  sessionId: string;
  initialSection: 'details' | 'family';
  homeDirectory: string;
  backLabel: string;
  back: () => void;
  select: (id: string) => void;
  viewGroup: (group: TaskGroup) => void;
  assign: (sessionId: string, targetId: string) => Promise<boolean>;
  detach: (groupId: string, sessionId: string) => Promise<boolean>;
  open: (session: Session) => void;
  primaryLabel: (session: Session) => string | null;
  actions: (session: Session) => ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [focused, setFocused] = useState(false);
  const [showFamily, setShowFamily] = useState(initialSection === 'family');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [changingGroup, setChangingGroup] = useState(false);
  const changeGroupButton = useRef<HTMLButtonElement>(null);
  const pickerWasOpen = useRef(false);
  useLayoutEffect(() => {
    // After a move, the trigger becomes enabled in this commit. Restore focus
    // here rather than while the native dialog closes and the button is busy.
    if (pickerWasOpen.current && !changingGroup) changeGroupButton.current?.focus();
    pickerWasOpen.current = changingGroup;
  }, [changingGroup]);
  const family = useMemo(() => forkFamily(state, sessionId), [state, sessionId]);
  const tree = useRef<HTMLDivElement>(null);
  const [positions, setPositions] = useState<Record<string, number>>({});
  const rows = family ? visibleForks(family, sessionId, collapsed, focused) : [];
  const path = family ? forkPath(family, sessionId) : new Set<string>();
  const groups = new Map(state.groups.flatMap((g) => g.sessionIds.map((id) => [id, g] as const)));
  const session = state.sessions[sessionId],
    group = groups.get(sessionId);
  const hasFamily = Boolean(family && family.nodes.size > 1);
  const familyVisible = showFamily && hasFamily;
  const groupTasks = group
    ? group.sessionIds.map((id) => state.sessions[id]).filter((s): s is Session => Boolean(s))
    : [];
  const maxDepth = Math.max(0, ...rows.map((n) => n.depth));
  const lane = (depth: number) => 17 + Math.min(depth, 8) * 16;
  const gutter = lane(maxDepth) + 40;
  const geometry = rows.map((n) => n.id).join('|');
  useLayoutEffect(() => {
    const element = tree.current;
    if (!element) return;
    const measure = () => {
      const top = element.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      element.querySelectorAll<HTMLElement>('[data-fork-id]').forEach((row) => {
        const rect = row.getBoundingClientRect();
        next[row.dataset.forkId!] = rect.top - top + rect.height / 2;
      });
      setPositions((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    for (const row of element.children) if (row instanceof HTMLElement) observer.observe(row);
    return () => observer.disconnect();
  }, [geometry, familyVisible, state]);
  function choose(id: string) {
    // Reveal a destination reached from its parent/child links without resetting
    // any other branch, including when the family is currently focused.
    if (family) {
      const ancestors = forkPath(family, id);
      setCollapsed((old) => new Set([...old].filter((item) => !ancestors.has(item))));
    }
    setNotice('');
    select(id);
  }
  if (!session || !family)
    return (
      <main className="task-view">
        <button onClick={back}>← Back to {backLabel}</button>
        <p className="task-empty">This task is no longer available in Monitor.</p>
      </main>
    );
  const parentId = session.lineage?.parentId,
    parent = parentId ? state.sessions[parentId] : undefined;
  const direct = family.nodes.get(sessionId)?.children || [];
  const familyTasks = [...family.nodes.values()].filter((n) => n.session);
  const groupCount = new Set(familyTasks.map((n) => groups.get(n.id)?.id).filter(Boolean)).size;
  const label = primaryLabel(session);
  return (
    <main className="task-view" aria-label="Task view">
      <header className="task-header">
        <nav className="task-breadcrumb" aria-label="Task breadcrumbs">
          <button onClick={back}>{backLabel}</button>
          <span aria-hidden="true">›</span>
          {group && (group.name || groupTasks.length > 1) && (
            <>
              <button onClick={() => viewGroup(group)}>{groupName(state, group)}</button>
              <span aria-hidden="true">›</span>
            </>
          )}
          <span aria-current="page">Task details</span>
        </nav>
        <div className="task-heading">
          <div>
            <h2>{session.title}</h2>
            <div className="task-metadata">
              <span className="task-status">
                <span className={`status-dot ${session.status}`} aria-hidden="true" />
                {stateLabel(state, session)}
              </span>
              <span className="task-provider">
                <ProviderIcon provider={session.provider} />
                {session.provider === 'codex' ? 'Codex' : 'Claude'}
              </span>
              <span title={new Date(session.updatedAt).toLocaleString()}>
                {age(session.updatedAt)}
              </span>
            </div>
          </div>
          {label && (
            <button className="primary" onClick={() => open(session)}>
              {label} ↗
            </button>
          )}
        </div>
      </header>
      {hasFamily && (
        <nav className="task-sections" aria-label="Task sections">
          <button
            aria-pressed={!familyVisible}
            onClick={() => {
              setShowFamily(false);
            }}
          >
            Details
          </button>
          <button aria-pressed={familyVisible} onClick={() => setShowFamily(true)}>
            <ForkIcon /> Fork family <span>{familyTasks.length}</span>
          </button>
        </nav>
      )}
      <div
        className={`task-layout${familyVisible ? '' : ' task-overview'}${!familyVisible && groupTasks.length > 1 ? ' with-members' : ''}`}
      >
        {familyVisible && (
          <section className="fork-family" aria-label="Fork family">
            <div className="fork-heading">
              <div>
                <h3>Fork family</h3>
                <p>
                  {focused
                    ? 'Ancestors and descendants of this task'
                    : `${familyTasks.length} ${familyTasks.length === 1 ? 'task' : 'tasks'} across ${groupCount} ${groupCount === 1 ? 'group' : 'groups'}`}
                </p>
              </div>
            </div>
            <div className="fork-toolbar">
              <button aria-pressed={focused} onClick={() => setFocused(!focused)}>
                <ForkIcon />
                Focus branch
              </button>
              {collapsed.size > 0 && (
                <button onClick={() => setCollapsed(new Set())}>Expand all</button>
              )}
            </div>
            {family.hasCycle && (
              <p className="fork-caution">
                The source reported circular ancestry. One link is omitted to keep navigation
                usable.
              </p>
            )}
            <div
              className="fork-tree"
              ref={tree}
              style={{ '--fork-gutter': `${gutter}px` } as CSSProperties}
            >
              <svg className="fork-lines" width={gutter - 24} height="100%" aria-hidden="true">
                {rows
                  .filter(
                    (n) =>
                      n.parentId &&
                      positions[n.parentId] !== undefined &&
                      positions[n.id] !== undefined,
                  )
                  .sort((a, b) => Number(path.has(a.id)) - Number(path.has(b.id)))
                  .map((n) => {
                    const parent = family.nodes.get(n.parentId!)!,
                      x = lane(parent.depth),
                      y = positions[n.id],
                      from = positions[parent.id];
                    return (
                      <path
                        key={n.id}
                        className={path.has(n.id) ? 'fork-edge highlighted' : 'fork-edge'}
                        d={`M${x} ${from} V${y - 8} Q${x} ${y} ${Math.min(x + 8, lane(n.depth))} ${y} H${lane(n.depth)}`}
                      />
                    );
                  })}
                {rows
                  .filter((n) => positions[n.id] !== undefined)
                  .map((n) => (
                    <g key={n.id} transform={`translate(${lane(n.depth)} ${positions[n.id]})`}>
                      {n.id === sessionId && <circle className="fork-selected-ring" r="10" />}
                      {n.session?.status === 'review' ? (
                        <rect
                          className="fork-node review"
                          x="-4"
                          y="-4"
                          width="8"
                          height="8"
                          transform="rotate(45)"
                        />
                      ) : n.session?.status === 'unknown' || !n.session ? (
                        <rect className="fork-node unknown" x="-4" y="-4" width="8" height="8" />
                      ) : (
                        <circle className={`fork-node ${n.session.status}`} r="4.5" />
                      )}
                    </g>
                  ))}
              </svg>
              {rows.map((node) => {
                const task = node.session,
                  taskGroup = groups.get(node.id),
                  hidden = collapsed.has(node.id) ? forkDescendants(family, node.id) : [];
                const review = hidden.filter((n) => n.session?.status === 'review').length;
                const running = hidden.filter((n) => n.session?.status === 'running').length;
                return (
                  <div
                    className="fork-row"
                    key={node.id}
                    data-fork-id={node.id}
                    data-testid="fork-row"
                  >
                    {task ? (
                      <button
                        className="fork-select"
                        aria-pressed={node.id === sessionId}
                        aria-label={`View task: ${task.title}`}
                        onClick={() => choose(node.id)}
                      >
                        <span className="fork-title">
                          <strong>{task.title}</strong>
                          <span className="fork-meta">
                            {taskGroup ? groupName(state, taskGroup) : 'No group'}
                            {taskGroup &&
                              (!isQueued(taskGroup) || isSnoozed(taskGroup)) &&
                              ` · ${location(taskGroup)}`}
                            {node.depth > 8 && ` · Level ${node.depth + 1}`}
                          </span>
                          {hidden.length > 0 && (
                            <span className="fork-hidden">
                              {hidden.length} hidden{review > 0 && ` · ${review} need review`}
                              {running > 0 && ` · ${running} running`}
                            </span>
                          )}
                        </span>
                        <span className="fork-row-status">
                          <span>{stateLabel(state, task)}</span>
                          <time
                            dateTime={
                              task.updatedAt ? new Date(task.updatedAt).toISOString() : undefined
                            }
                          >
                            {age(task.updatedAt)}
                          </time>
                        </span>
                      </button>
                    ) : (
                      <div className="fork-missing">
                        <strong>Parent task unavailable</strong>
                        <span>Missing or hidden in the source app</span>
                      </div>
                    )}
                    {node.children.length > 0 && (
                      <button
                        className="fork-collapse"
                        aria-label={`${collapsed.has(node.id) ? 'Expand' : 'Collapse'} forks of ${task?.title || 'unavailable parent'}`}
                        aria-expanded={!collapsed.has(node.id)}
                        onClick={() => {
                          if (
                            !collapsed.has(node.id) &&
                            node.id !== sessionId &&
                            path.has(node.id) &&
                            task
                          )
                            select(node.id);
                          if (!task && path.has(node.id)) return;
                          setCollapsed((old) => {
                            const next = new Set(old);
                            if (next.has(node.id)) next.delete(node.id);
                            else next.add(node.id);
                            return next;
                          });
                        }}
                        disabled={!task && path.has(node.id)}
                      >
                        {collapsed.has(node.id) ? '›' : '⌄'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
        <aside className="task-details" aria-label="Task details">
          <h3>Task details</h3>
          {group && (
            <div className="task-field">
              <span className="task-field-label">Group</span>
              <div className="task-group-value">
                <strong data-testid="task-group-name">{groupName(state, group)}</strong>
                <button
                  ref={changeGroupButton}
                  disabled={busy}
                  onClick={() => setChangingGroup(true)}
                >
                  Change group
                </button>
              </div>
              <button className="task-text-link" onClick={() => viewGroup(group)}>
                View group →
              </button>
              <span className="task-field-note">{location(group)}</span>
            </div>
          )}
          <div className="task-field">
            <span className="task-field-label">Project directory</span>
            <code>{displayDirectory(session.directory, homeDirectory) || 'Unavailable'}</code>
          </div>
          <div className="task-field">
            <span className="task-field-label">Source status</span>
            <p>{session.detail}</p>
          </div>
          <hr />
          <div className="task-field">
            <span className="task-field-label">Forked from</span>
            {parent ? (
              <button className="task-text-link" onClick={() => choose(parent.id)}>
                {parent.title} ↗
              </button>
            ) : (
              <span>
                {parentId
                  ? 'Parent task unavailable'
                  : session.lineage
                    ? 'No parent recorded'
                    : 'Ancestry unavailable'}
              </span>
            )}
          </div>
          {session.createdAt && (
            <div className="task-field">
              <span className="task-field-label">Task created</span>
              <time dateTime={new Date(session.createdAt).toISOString()}>
                {new Date(session.createdAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </time>
            </div>
          )}
          <div className="task-field">
            <span className="task-field-label">Direct forks · {direct.length}</span>
            {direct.length ? (
              direct.map((id) => {
                const child = family.nodes.get(id)!.session;
                return (
                  child && (
                    <div className="task-relative" key={id}>
                      <button className="task-text-link" onClick={() => choose(id)}>
                        {child.title} ↗
                      </button>
                      <small>
                        {groups.get(id) ? groupName(state, groups.get(id)!) : 'No group'}
                      </small>
                    </div>
                  )
                );
              })
            ) : (
              <span className="task-field-note">No recorded forks</span>
            )}
          </div>
          <div className="task-extra-actions">
            {actions(session)}
            {group && group.sessionIds.length > 1 && (
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await detach(group.id, session.id);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Move to own group
              </button>
            )}
          </div>
        </aside>
        {!familyVisible && group && groupTasks.length > 1 && (
          <section className="task-group-members" aria-label="Tasks in this group">
            <h3>
              Tasks in this group <span>{groupTasks.length}</span>
            </h3>
            <button className="task-text-link" onClick={() => viewGroup(group)}>
              {groupName(state, group)} →
            </button>
            {groupTasks.map((member) => (
              <button
                className="task-member"
                key={member.id}
                aria-label={`View task: ${member.title}`}
                aria-pressed={member.id === sessionId}
                onClick={() => choose(member.id)}
              >
                <strong>{member.title}</strong>
                <span>
                  <span className={`status-dot ${member.status}`} aria-hidden="true" />
                  {stateLabel(state, member)}
                </span>
              </button>
            ))}
          </section>
        )}
      </div>
      {notice && (
        <p className="task-notice" role="status">
          {notice}
        </p>
      )}
      {changingGroup && group && (
        <GroupPicker
          state={state}
          currentGroupId={group.id}
          taskTitle={session.title}
          homeDirectory={homeDirectory}
          close={() => setChangingGroup(false)}
          move={async (target) => {
            setBusy(true);
            try {
              const moved = await assign(sessionId, target.id);
              if (moved)
                setNotice(`Moved to ${groupName(state, target)}. Fork ancestry is preserved.`);
              return moved;
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {session.title} · {group ? groupName(state, group) : 'No group'} ·{' '}
        {stateLabel(state, session)}
      </span>
    </main>
  );
}
