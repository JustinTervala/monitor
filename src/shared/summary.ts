import type { MonitorState, Session } from './types';

export function handoffSummary(state: MonitorState, session: Session): string | null {
  const summary = state.summaries[session.id];
  return summary &&
    !session.archived &&
    !session.awaitingInput &&
    ['review', 'read'].includes(session.status) &&
    summary.completionKey === session.attentionKey &&
    summary.activityAt === (session.activityAt || 0)
    ? summary.text
    : null;
}
