import { basename } from 'node:path';
import type { Session } from '../../shared/types';
import type { DesktopRecord, LiveProcess } from './catalog';

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
    observedAt: now,
    archived: record.archived,
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
    return observed(
      'review',
      live.waitingFor === 'permission prompt'
        ? 'Waiting for approval in Claude'
        : 'Waiting for your input in Claude',
      // The registry stamps the moment the process entered this wait.
      live.statusUpdatedAt ? `waiting:${live.statusUpdatedAt}` : null,
    );
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
