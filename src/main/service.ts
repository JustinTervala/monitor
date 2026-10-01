import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import {
  applyCommand,
  groupName,
  initiallyQueued,
  isCurrentlyActive,
  isQueued,
  isSnoozed,
  newGroup,
} from '../shared/queue';
import type { Command, MonitorState, ProviderHealth, Session, Snapshot } from '../shared/types';
import type { SessionProvider } from '../providers/provider';
import { MonitorStore } from './store';
import { canResumeInTerminal, resumeCommand } from '../shared/resume';

export interface NotificationEvent {
  title: string;
  body: string;
  sessionId: string;
}
export class MonitorService extends EventEmitter {
  private state: MonitorState;
  private health = new Map<string, ProviderHealth>();
  private baselined = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;
  private publishTimer: NodeJS.Timeout | null = null;
  private wakeTimer: NodeJS.Timeout | null = null;
  constructor(
    private store: MonitorStore,
    private providers: SessionProvider[],
    private notify: (event: NotificationEvent) => void,
  ) {
    super();
    this.state = store.read();
    for (const session of Object.values(this.state.sessions)) {
      const observation = (this.state.observations[session.id] ??= {
        firstSeenAt: session.observedAt || Date.now(),
        lastActivityAt: session.activityAt || 0,
      });
      if (session.status !== 'unknown' && session.evidence !== 'unavailable')
        observation.lastKnown = { status: session.status, observedAt: session.observedAt };
      session.status = 'unknown';
      session.evidence = 'unavailable';
      session.detail = 'Reconnecting to the source app';
      session.attentionKey = null;
    }
  }
  snapshot(): Snapshot {
    return {
      homeDirectory: homedir(),
      state: structuredClone(this.state),
      health: [...this.health.values()],
    };
  }
  async start() {
    for (const provider of this.providers) {
      await provider.start({
        sessions: (sessions) => this.ingest(sessions),
        health: (health) => {
          if (health.state === 'offline')
            for (const id of this.baselined)
              if (this.state.sessions[id]?.provider === health.provider) this.baselined.delete(id);
          this.health.set(health.provider, health);
          this.publish();
        },
      });
    }
    this.updateTracking();
    this.scheduleWake();
  }
  private ingest(sessions: Session[]) {
    // Discover everything; only recent work and observed activity enter the queue.
    const grouped = new Map(
      this.state.groups.flatMap((group) => group.sessionIds.map((id) => [id, group] as const)),
    );
    let trackingChanged = false;
    for (const session of [...sessions].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    )) {
      if (session.archived || grouped.has(session.id)) continue;
      const group = { ...newGroup(session.id), inQueue: initiallyQueued(session) };
      this.state.groups.push(group);
      grouped.set(session.id, group);
      trackingChanged = true;
    }
    let changed = trackingChanged;
    for (const session of sessions) {
      const old = this.state.sessions[session.id];
      const observation = (this.state.observations[session.id] ??= {
        firstSeenAt: Date.now(),
        lastActivityAt: 0,
      });
      const group = grouped.get(session.id);
      const activityAt = session.activityAt || 0;
      if (
        group &&
        !group.archived &&
        !group.inQueue &&
        (isCurrentlyActive(session) ||
          (activityAt > observation.lastActivityAt && activityAt >= observation.firstSeenAt))
      ) {
        group.inQueue = true;
        changed = true;
      }
      observation.lastActivityAt = Math.max(observation.lastActivityAt, activityAt);
      const { observedAt: _oldTime, ...oldValue } = old || {};
      const { observedAt: _newTime, ...newValue } = session;
      if (old && JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      changed = true;
      this.state.sessions[session.id] = session;
      if (session.status !== 'unknown' && session.evidence !== 'unavailable')
        observation.lastKnown = { status: session.status, observedAt: session.observedAt };
      if (session.evidence === 'unavailable') continue;
      const key = session.attentionKey;
      const firstObservation = !this.baselined.has(session.id);
      // An idle snapshot may arrive before its turn history. Do not treat that
      // history backfill as a completion; baseline when identity or activity is known.
      if (session.status === 'running' || key) this.baselined.add(session.id);
      if (
        !['review', 'read'].includes(session.status) ||
        !key ||
        this.state.notificationKeys[session.id] === key
      )
        continue;
      // Remember even suppressed events: startup, snooze and notification toggles
      // must not replay old completions when they are lifted.
      this.state.notificationKeys[session.id] = key;
      if (
        !firstObservation &&
        session.evidence === 'live' &&
        this.state.notifications &&
        group &&
        isQueued(group) &&
        !isSnoozed(group)
      ) {
        // Persist the receipt before emitting the OS side effect (at-most-once).
        this.store.write(this.state);
        this.notify({
          title: groupName(this.state, group),
          body: `${session.provider === 'codex' ? 'Codex' : 'Claude'} · ${session.status === 'read' ? 'Turn finished' : session.detail}`,
          sessionId: session.id,
        });
      }
    }
    if (trackingChanged) this.updateTracking();
    if (changed) {
      this.persistSoon();
      this.publish();
    }
  }
  command(command: Command): Snapshot {
    this.state = applyCommand(this.state, command);
    this.store.write(this.state);
    this.updateTracking();
    this.scheduleWake();
    this.publish();
    return this.snapshot();
  }
  private updateTracking() {
    const ids = new Set(this.state.groups.flatMap((g) => g.sessionIds));
    for (const provider of this.providers)
      provider.track(
        [...ids]
          .map((id) => this.state.sessions[id])
          .filter((s) => s?.provider === provider.id)
          .map((s) => s.externalId),
      );
  }
  sessionUrl(id: string): string {
    const session = this.state.sessions[id];
    const provider = this.providers.find((p) => p.id === session?.provider);
    if (!session || !provider) throw new Error('This session provider is not available.');
    return provider.sessionUrl(session.externalId);
  }
  canOpen(id: string): boolean {
    return this.state.sessions[id]?.openable !== false;
  }
  terminalPid(id: string): number | null {
    return this.state.sessions[id]?.terminalPid ?? null;
  }
  terminalTarget(id: string) {
    const session = this.state.sessions[id];
    if (!session?.terminalPid) throw new Error('This session is not running in a terminal.');
    return {
      pid: session.terminalPid,
      provider: session.provider,
      identity: session.terminalIdentity,
    };
  }
  resumeCommand(id: string): string {
    const session = this.state.sessions[id];
    const command = session && resumeCommand(session);
    if (!command) throw new Error('This session cannot be resumed from a terminal.');
    return command;
  }
  async terminalResumeCommand(id: string): Promise<string> {
    await this.refresh();
    const session = this.state.sessions[id];
    if (!session || !canResumeInTerminal(session))
      throw new Error('This task may still be active. Open it in its app or terminal instead.');
    return this.resumeCommand(id);
  }
  async refresh() {
    await Promise.all(this.providers.map((provider) => provider.refresh()));
  }
  private persistSoon() {
    if (!this.persistTimer)
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.store.write(this.state);
      }, 500);
  }
  private publish() {
    if (!this.publishTimer)
      this.publishTimer = setTimeout(() => {
        this.publishTimer = null;
        this.emit('snapshot', this.snapshot());
      }, 100);
  }
  private scheduleWake() {
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    const deadlines = this.state.groups.flatMap((g) =>
      g.snooze?.until != null ? [g.snooze.until] : [],
    );
    if (!deadlines.length) return;
    const next = Math.min(...deadlines);
    this.wakeTimer = setTimeout(
      () => {
        const now = Date.now();
        for (const group of this.state.groups)
          if (group.snooze?.until != null && group.snooze.until <= now) group.snooze = null;
        this.store.write(this.state);
        this.publish();
        this.scheduleWake();
      },
      Math.min(Math.max(1, next - Date.now()), 2_147_483_647),
    );
  }
  stop() {
    for (const provider of this.providers) provider.stop();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.store.write(this.state);
    this.store.close();
    this.removeAllListeners();
  }
}
