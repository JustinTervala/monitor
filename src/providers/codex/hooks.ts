import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../shared/types';
import { validThreadId } from './catalog';

export const defaultHooksDirectory = () =>
  process.env.MONITOR_CODEX_HOOKS_DIR ||
  join(homedir(), 'Library', 'Application Support', 'Monitor', 'codex-hooks');
export const ACTIVITY_LEASE_MS = 120_000;
const events = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'Stop',
  'Interrupt',
  'SessionEnd',
]);
interface Observation {
  event: string;
  turnId: string | null;
  at: number;
}
export interface HookRecord {
  activity?: Observation;
  completion?: Observation;
}

function observation(value: any, completion: boolean, now: number): Observation | undefined {
  if (
    !value ||
    !(completion ? value.event === 'TurnComplete' : events.has(value.event)) ||
    typeof value.at !== 'number' ||
    !Number.isFinite(value.at) ||
    value.at <= 0 ||
    value.at > now + 1000 ||
    (value.turnId !== null && (typeof value.turnId !== 'string' || !validThreadId(value.turnId))) ||
    (!value.turnId && !['SessionStart', 'SessionEnd'].includes(value.event))
  )
    return;
  return { event: value.event, turnId: value.turnId, at: value.at };
}

/** Only Monitor metadata is read; the Codex transcript is never opened. */
export function readHookRecords(directory: string, now = Date.now()): Map<string, HookRecord> {
  const records = new Map<string, HookRecord>();
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.uid !== process.getuid?.() || root.mode & 0o077) return records;
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json') || !validThreadId(name.slice(0, -5))) continue;
      let fd: number | undefined;
      try {
        fd = openSync(
          join(directory, name),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.size > 16384 ||
          info.uid !== process.getuid?.() ||
          info.mode & 0o077
        )
          continue;
        const raw = JSON.parse(readFileSync(fd, 'utf8'));
        if (raw.version !== 1 || raw.sessionId !== name.slice(0, -5)) continue;
        records.set(raw.sessionId, {
          activity: observation(raw.activity, false, now),
          completion: observation(raw.completion, true, now),
        });
      } catch {
        /* An atomic replacement or corrupt record must not stop other observations. */
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
  } catch {
    /* Plugin not installed, or observations temporarily unavailable. */
  }
  return records;
}

/** Desktop state wins. Hooks fill gaps only; Stop alone never produces a completion. */
export function sessionFromHooks(
  base: Session,
  record: HookRecord | undefined,
  startedAt: number,
  now = Date.now(),
): Session {
  if (!record) return base;
  const { activity, completion } = record;
  const sameTurn = !activity?.turnId || activity.turnId === completion?.turnId;
  const completed =
    completion &&
    sameTurn &&
    (!activity || completion.at >= activity.at || activity.event === 'SessionEnd');
  if (completed)
    return {
      ...base,
      status: 'review',
      detail: 'Turn finished in Codex · read receipt unavailable',
      attentionKey: `result:${completion.turnId}`,
      observedAt: now,
      updatedAt: Math.max(base.updatedAt, completion.at),
      evidence: completion.at >= startedAt ? 'live' : 'history',
    };
  if (!activity) return base;
  if (activity.event === 'Interrupt')
    return {
      ...base,
      status: 'review',
      detail: 'Turn interrupted in Codex · read receipt unavailable',
      attentionKey: `result:${activity.turnId}`,
      observedAt: now,
      updatedAt: Math.max(base.updatedAt, activity.at),
      evidence: activity.at >= startedAt ? 'live' : 'history',
    };
  const terminal = ['Stop', 'SessionEnd', 'SessionStart'].includes(activity.event);
  if (!terminal && now - activity.at <= ACTIVITY_LEASE_MS)
    return {
      ...base,
      status: 'running',
      detail: 'Recent Codex activity · observed by plugin',
      attentionKey: null,
      evidence: 'live',
      observedAt: now,
      updatedAt: Math.max(base.updatedAt, activity.at),
    };
  return {
    ...base,
    status: 'unknown',
    evidence: 'unavailable',
    attentionKey: null,
    detail:
      activity.event === 'Stop'
        ? 'Codex reached its stop hooks; waiting for completion confirmation'
        : 'Codex plugin activity is no longer current; waiting for live state',
  };
}
