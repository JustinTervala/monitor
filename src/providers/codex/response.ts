import { DatabaseSync } from 'node:sqlite';
import type { Session } from '../../shared/types';
import { boundedResponse, responseTail } from '../completed-response';
import { findStateDatabase, validThreadId } from './catalog';

export async function readCodexResponse(home: string, session: Session): Promise<string | null> {
  if (!validThreadId(session.externalId) || !session.attentionKey?.startsWith('result:'))
    return null;
  const db = new DatabaseSync(findStateDatabase(home), { readOnly: true });
  let path: string | null = null;
  try {
    const row = db
      .prepare('SELECT rollout_path,archived FROM threads WHERE id=?')
      .get(session.externalId);
    if (row && !row.archived && typeof row.rollout_path === 'string') path = row.rollout_path;
  } finally {
    db.close();
  }
  if (!path) return null;
  const records = await responseTail(path);
  const events = records.filter(
    (v) =>
      v.type === 'event_msg' &&
      ['task_started', 'task_complete', 'turn_aborted'].includes(v.payload?.type),
  );
  const last = events.at(-1)?.payload;
  // The source's completion event contains its final answer, with an exact turn id.
  // A newer start, interrupted turn or missing final response must abstain.
  return last?.type === 'task_complete' && `result:${last.turn_id}` === session.attentionKey
    ? boundedResponse(last.last_agent_message)
    : null;
}
