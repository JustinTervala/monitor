import { useEffect, useMemo, useRef, useState } from 'react';
import type { MonitorState, TaskGroup } from '../shared/types';
import { groupDestinations } from './group-picker';

function activityLabel(time: number) {
  if (!time) return 'No activity recorded';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
  if (minutes < 1) return 'Active just now';
  if (minutes < 60) return `Active ${minutes} min ago`;
  if (minutes < 1440) return `Active ${Math.floor(minutes / 60)} hr ago`;
  return `Active ${new Date(time).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
}

export function GroupPicker({
  state,
  currentGroupId,
  taskTitle,
  homeDirectory,
  move,
  close,
}: {
  state: MonitorState;
  currentGroupId: string;
  taskTitle: string;
  homeDirectory: string;
  move: (group: TaskGroup) => Promise<boolean>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const [query, setQuery] = useState('');
  const [movingId, setMovingId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const destinations = useMemo(
    () => groupDestinations(state, currentGroupId, query, homeDirectory),
    [state, currentGroupId, query, homeDirectory],
  );
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    search.current?.focus();
    return () => element.close();
  }, []);
  function dismiss() {
    dialog.current?.close();
    close();
  }
  async function choose(group: TaskGroup) {
    if (moving.current) return;
    moving.current = true;
    setMovingId(group.id);
    setError('');
    try {
      if (await move(group)) dismiss();
      else setError('Could not move this task. Please try again.');
    } catch {
      setError('Could not move this task. Please try again.');
    } finally {
      moving.current = false;
      setMovingId(null);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="group-picker"
      aria-labelledby="group-picker-title"
      aria-describedby="group-picker-task"
      onCancel={(event) => {
        event.preventDefault();
        if (!moving.current) dismiss();
      }}
      onKeyDown={(event) => {
        // Search inputs consume Escape to clear their text by default. Here it
        // cancels the whole picker, matching Escape from any destination button.
        if (event.key === 'Escape') {
          event.preventDefault();
          if (!moving.current) dismiss();
        }
      }}
    >
      <div className="dialog-top">
        <h2 id="group-picker-title">Change group</h2>
        <button
          className="icon-button"
          aria-label="Cancel change group"
          disabled={Boolean(movingId)}
          onClick={() => {
            if (!moving.current) dismiss();
          }}
        >
          ×
        </button>
      </div>
      <p id="group-picker-task" className="group-picker-task">
        Move “{taskTitle}”
      </p>
      <input
        ref={search}
        type="search"
        aria-label="Search groups"
        placeholder="Search groups, projects, or tasks"
        value={query}
        disabled={Boolean(movingId)}
        onChange={(event) => {
          setQuery(event.target.value);
          setError('');
          results.current?.scrollTo(0, 0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            results.current?.querySelector<HTMLButtonElement>('button')?.focus();
          }
        }}
      />
      <p className="group-picker-caption" role="status">
        {query.trim()
          ? `${destinations.length} ${destinations.length === 1 ? 'group' : 'groups'} found`
          : 'Recently active groups'}
      </p>
      <div ref={results} className="group-picker-results" aria-busy={Boolean(movingId)}>
        {destinations.map((entry) => (
          <button
            key={entry.group.id}
            className="group-picker-choice"
            data-testid="group-choice"
            data-group-id={entry.group.id}
            aria-label={`Move to ${entry.name}`}
            aria-describedby={`group-choice-meta-${entry.group.id} group-choice-activity-${entry.group.id}`}
            disabled={Boolean(movingId)}
            onClick={() => void choose(entry.group)}
          >
            <span className="group-picker-choice-name">
              <strong>{entry.name}</strong>
              <span aria-hidden="true">{movingId === entry.group.id ? 'Moving…' : '→'}</span>
            </span>
            <span className="group-picker-choice-meta" id={`group-choice-meta-${entry.group.id}`}>
              {entry.project} · {entry.count} {entry.count === 1 ? 'task' : 'tasks'} ·{' '}
              {entry.location}
            </span>
            <span
              className="group-picker-choice-meta"
              id={`group-choice-activity-${entry.group.id}`}
            >
              {activityLabel(entry.activityAt)}
            </span>
          </button>
        ))}
        {!destinations.length && (
          <p className="group-picker-empty">
            {query.trim()
              ? 'No groups match your search.'
              : 'No recent groups. Search to find a destination.'}
          </p>
        )}
      </div>
      {movingId && (
        <p className="group-picker-caption" role="status">
          Moving task…
        </p>
      )}
      {error && (
        <p className="group-picker-error" role="alert">
          {error}
        </p>
      )}
    </dialog>
  );
}
