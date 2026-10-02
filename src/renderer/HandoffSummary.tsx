import { handoffSummary } from '../shared/summary';
import type { MonitorState, Session } from '../shared/types';

export function HandoffSummary({ state, session }: { state: MonitorState; session: Session }) {
  const text = handoffSummary(state, session);
  return text ? (
    <span className="handoff-summary" data-testid="handoff-summary">
      {text}
    </span>
  ) : null;
}
