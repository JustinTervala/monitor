import { isSnoozed } from '../../shared/queue';
import type { MonitorState, Session } from '../../shared/types';

export const SUMMARY_DELAY_MS = 5 * 60 * 1000;
export type SummaryRunner = (response: string, signal: AbortSignal) => Promise<string | null>;
export interface SummaryOptions {
  run: SummaryRunner;
  delayMs?: number;
}
interface Job {
  session: Session;
  due: number;
  controller: AbortController;
}

/** In-memory admission only: reconnects and cache misses never backfill work. */
export class SummaryQueue {
  private pending = new Map<string, Job>();
  private receipts = new Map<string, string>();
  private liveBaselined = new Set<string>();
  private active: Job | null = null;
  private activeDone: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  constructor(
    private state: () => MonitorState,
    private read: (session: Session) => Promise<string | null>,
    private options: SummaryOptions,
    private changed: () => void,
  ) {}
  private signature(session: Session) {
    return `${session.attentionKey}:${session.activityAt || 0}`;
  }
  private eligible(session: Session) {
    const group = this.state().groups.find((g) => g.sessionIds.includes(session.id));
    return Boolean(
      group &&
      !group.archived &&
      !isSnoozed(group) &&
      !session.archived &&
      session.evidence === 'live' &&
      session.status === 'review' &&
      !session.awaitingInput &&
      session.attentionKey?.startsWith('result:'),
    );
  }
  private current(job: Job) {
    const session = this.state().sessions[job.session.id];
    return (
      !this.stopped &&
      !job.controller.signal.aborted &&
      session &&
      this.eligible(session) &&
      this.signature(session) === this.signature(job.session)
    );
  }
  observe(session: Session, firstObservation: boolean) {
    if (this.stopped) return;
    const firstLiveObservation = !this.liveBaselined.has(session.id);
    if (session.evidence !== 'live') this.liveBaselined.delete(session.id);
    else if (session.status === 'running' || session.attentionKey)
      this.liveBaselined.add(session.id);
    const signature = this.signature(session);
    const old = this.receipts.get(session.id);
    if (session.attentionKey?.startsWith('result:'))
      this.receipts.set(session.id, session.attentionKey);
    const queued = this.pending.get(session.id);
    const updating = queued && this.signature(queued.session) !== signature;
    if (
      !this.eligible(session) ||
      (queued && this.signature(queued.session) !== signature) ||
      (this.active?.session.id === session.id && !this.current(this.active))
    )
      this.cancel(session.id);
    // Record suppressed completions too; opening, unsnoozing and restoring do not replay them.
    if (
      firstObservation ||
      firstLiveObservation ||
      (old === session.attentionKey && !updating) ||
      !this.eligible(session)
    )
      return;
    this.pending.set(session.id, {
      session: { ...session },
      due: Date.now() + (this.options.delayMs ?? SUMMARY_DELAY_MS),
      controller: new AbortController(),
    });
    this.pump();
  }
  opened(id: string) {
    this.cancel(id);
    this.pump();
  }
  reconcile() {
    let changed = false;
    const state = this.state();
    for (const [id, cached] of Object.entries(state.summaries)) {
      const session = state.sessions[id];
      const group = state.groups.find((g) => g.sessionIds.includes(id));
      const newActivity =
        session &&
        (session.status === 'running' ||
          session.awaitingInput ||
          (session.attentionKey !== null &&
            (session.attentionKey !== cached.completionKey ||
              (session.activityAt || 0) !== cached.activityAt)));
      if (!session || session.archived || !group || group.archived || newActivity) {
        delete state.summaries[id];
        changed = true;
      }
    }
    for (const [id, job] of this.pending)
      if (!this.current(job)) {
        job.controller.abort();
        this.pending.delete(id);
      }
    // An aborted old job can share a chat id with its newly queued successor.
    if (this.active && !this.current(this.active)) this.active.controller.abort();
    if (changed) this.changed();
    this.pump();
  }
  private cancel(id: string) {
    this.pending.get(id)?.controller.abort();
    this.pending.delete(id);
    if (this.active?.session.id === id) this.active.controller.abort();
  }
  private pump() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || this.active) return;
    const job = [...this.pending.values()].sort((a, b) => a.due - b.due)[0];
    if (!job) return;
    if (job.due > Date.now()) {
      this.timer = setTimeout(() => this.pump(), job.due - Date.now());
      return;
    }
    this.pending.delete(job.session.id);
    if (!this.current(job)) {
      this.pump();
      return;
    }
    this.active = job;
    this.activeDone = this.generate(job).finally(() => {
      this.active = null;
      this.activeDone = null;
      this.pump();
    });
  }
  private async generate(job: Job) {
    try {
      const response = await this.read(job.session);
      if (!response || !this.current(job)) return;
      const text = await this.options.run(response, job.controller.signal);
      if (!text || !this.current(job)) return;
      this.state().summaries[job.session.id] = {
        completionKey: job.session.attentionKey!,
        activityAt: job.session.activityAt || 0,
        text,
      };
      this.changed();
    } catch {
      // A failed read/auth/model call is quiet and never retried for an old completion.
    }
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const id of this.pending.keys()) this.cancel(id);
    this.active?.controller.abort();
    return this.activeDone ?? Promise.resolve();
  }
}
