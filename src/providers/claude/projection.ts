import { basename } from 'node:path';
import type { Session } from '../../shared/types';
import type { DesktopRecord, HookSession, LiveProcess, TerminalProcess } from './catalog';

export function sessionFromRecord(
  record: DesktopRecord,
  live: LiveProcess | undefined,
  desktopRunning: boolean,
  now = Date.now(),
): Session {
  const base = {
    id: `claude:${record.sessionId}`,
    provider: 'claude' as const,
    externalId: record.sessionId,
    title: record.title || (record.cwd && basename(record.cwd)) || 'Untitled Claude task',
    directory: record.cwd,
    updatedAt: record.lastActivityAt ?? record.createdAt ?? 0,
    activityAt: record.lastActivityAt ?? undefined,
    observedAt: now,
    archived: record.archived,
    openable: true,
    resumeId: record.cliSessionId,
    // Set when the desktop session was resumed with `claude --resume` in a terminal.
    terminalPid: live && 'sessionId' in live ? live.pid : null,
  };
  if (!desktopRunning)
    return {
      ...base,
      status: 'unknown',
      detail: 'Claude desktop is not running; last known state is not current',
      evidence: 'unavailable',
      attentionKey: null,
    };
  const observed = (
    status: Session['status'],
    detail: string,
    attentionKey: string | null = null,
  ): Session => ({ ...base, status, detail, attentionKey, evidence: 'live' });

  if (live?.status === 'waiting')
    return {
      ...observed(
        'review',
        live.waitingFor === 'permission prompt'
          ? 'Waiting for approval in Claude'
          : 'Waiting for your input in Claude',
        // The registry stamps the moment the process entered this wait.
        live.statusUpdatedAt ? `waiting:${live.statusUpdatedAt}` : null,
      ),
      awaitingInput: true,
    };
  if (live?.status === 'busy' || live?.status === 'shell')
    return observed('running', 'Claude is working');

  // No active execution. The desktop has no persisted unread flag, so a focus of
  // the session after the result is the acknowledgment evidence.
  const focused = record.lastFocusedAt ?? 0;
  if (record.errorAt)
    return focused >= record.errorAt
      ? observed('read', 'Error seen in Claude', `error:${record.errorAt}`)
      : observed('review', 'Claude reported an error', `error:${record.errorAt}`);
  if (record.lastAssistantUuid || record.completedTurns) {
    // lastAssistantUuid changes per message and can be saved mid-wrap-up, so it
    // would identify one turn twice. The completed-turn count changes once.
    const key = `result:${record.completedTurns}`;
    return record.lastActivityAt && focused >= record.lastActivityAt
      ? observed('read', 'Opened in Claude since the last response', key)
      : observed('review', 'New response · not opened in Claude since', key);
  }
  return observed('unknown', 'No completed Claude turn observed yet');
}

/** Terminal ids are prefixed so they can never be mistaken for a desktop route. */
export const terminalExternalId = (sessionId: string) => `cli_${sessionId}`;

/**
 * A `claude` CLI session. Running and waiting come from its live registry entry;
 * turn results and exits from the monitor-hooks plugin. A terminal has no read
 * receipt, so a result stays in review until the session ends.
 */
export function sessionFromTerminal(
  sessionId: string,
  hooks: HookSession | undefined,
  live: TerminalProcess | undefined,
  now = Date.now(),
): Session {
  const directory = hooks?.cwd ?? live?.cwd ?? null;
  const times = [hooks?.startedAt, hooks?.result?.at, hooks?.endedAt, live?.statusUpdatedAt];
  const base = {
    id: `claude:${terminalExternalId(sessionId)}`,
    provider: 'claude' as const,
    externalId: terminalExternalId(sessionId),
    title:
      hooks?.title ||
      live?.name ||
      `${(directory && basename(directory)) || 'Claude'} · terminal ${sessionId.slice(0, 8)}`,
    directory,
    updatedAt: Math.max(0, ...times.map((t) => t ?? 0)),
    activityAt: Math.max(
      0,
      hooks?.startedAt ?? 0,
      hooks?.result?.at ?? 0,
      live?.statusUpdatedAt ?? 0,
    ),
    observedAt: now,
    archived: false,
    openable: false,
    resumeId: sessionId,
    terminalPid: live?.pid ?? null,
  };
  const evidence: Session['evidence'] = live ? 'live' : 'history';
  const observed = (
    status: Session['status'],
    detail: string,
    attentionKey: string | null = null,
  ): Session => ({ ...base, status, detail, attentionKey, evidence });

  if (live?.status === 'waiting')
    return {
      ...observed(
        'review',
        live.waitingFor === 'permission prompt'
          ? 'Waiting for approval in the terminal'
          : 'Waiting for your input in the terminal',
        live.statusUpdatedAt ? `waiting:${live.statusUpdatedAt}` : null,
      ),
      awaitingInput: true,
    };
  if (live?.status === 'busy' || live?.status === 'shell')
    return observed('running', 'Claude is working in the terminal');
  const result = hooks?.result;
  if (!result)
    return live
      ? observed(
          'unknown',
          hooks ? 'No completed turn recorded yet' : 'Install monitor-hooks to see results',
        )
      : {
          ...observed('unknown', 'Claude terminal session is not running'),
          evidence: 'unavailable',
        };
  if (hooks?.endedAt && hooks.endedAt >= result.at)
    return observed('read', 'Terminal session ended after this result', result.key);
  if (!live)
    return observed(
      'review',
      result.error
        ? 'Claude reported an error; session exited'
        : 'Session exited after this response',
      result.key,
    );
  return observed(
    'review',
    result.error ? 'Claude reported an error in the terminal' : 'New response in the terminal',
    result.key,
  );
}
