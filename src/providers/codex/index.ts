import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvider, ObserverCallbacks } from '../provider';
import type { Session } from '../../shared/types';
import { readCatalog, validThreadId } from './catalog';
import { CodexTransport } from './transport';
import {
  projectConversation,
  patchProjection,
  sessionFromProjection,
  type Projection,
} from './projection';

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const;
  private callbacks: ObserverCallbacks | null = null;
  private transport: CodexTransport;
  private sessions = new Map<string, Session>();
  private live = new Map<string, { revision: number; owner: string; state: Projection }>();
  private tracked: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private lastObservedAt: number | null = null;
  private resyncTimes = new Map<string, number>();
  private protocolError: string | null = null;
  constructor(readonly home = process.env.CODEX_HOME || join(homedir(), '.codex')) {
    this.transport = new CodexTransport(join(home, 'ipc', 'ipc.sock'));
  }
  async start(callbacks: ObserverCallbacks) {
    this.callbacks = callbacks;
    callbacks.health({
      provider: this.id,
      state: 'connecting',
      message: 'Connecting to local Codex',
      lastObservedAt: null,
    });
    await this.refresh();
    this.transport.on('ready', () => {
      this.connected = true;
      this.health('live', 'Connected to Codex desktop · local sessions');
    });
    this.transport.on('offline', (message: string) => {
      this.connected = false;
      this.live.clear();
      for (const [id, s] of this.sessions)
        this.sessions.set(id, {
          ...s,
          status: 'unknown',
          evidence: 'unavailable',
          attentionKey: null,
          detail: 'Codex desktop disconnected; last known state is not current',
        });
      this.publish();
      this.health('offline', message);
    });
    this.transport.on('message', (message) => this.handleMessage(message));
    this.transport.start();
    this.timer = setInterval(() => void this.refresh(), 5000);
  }
  private health(state: 'live' | 'offline' | 'degraded', message: string) {
    this.callbacks?.health({
      provider: this.id,
      state,
      message,
      lastObservedAt: this.lastObservedAt,
    });
  }
  private publish() {
    this.callbacks?.sessions([...this.sessions.values()]);
  }
  async refresh() {
    try {
      const rows = readCatalog(this.home, this.tracked);
      for (const row of rows) {
        const live = this.live.get(row.externalId);
        this.sessions.set(row.externalId, live ? sessionFromProjection(row, live.state) : row);
      }
      this.publish();
      if (this.connected)
        this.health(
          this.protocolError ? 'degraded' : 'live',
          this.protocolError || 'Connected to Codex desktop · local sessions',
        );
    } catch (error) {
      this.health('degraded', error instanceof Error ? error.message : String(error));
    }
  }
  track(externalIds: string[]) {
    this.tracked = externalIds.filter(validThreadId);
    for (const id of this.live.keys()) if (!this.tracked.includes(id)) this.live.delete(id);
    this.transport.track(this.tracked);
  }
  private invalidate(id: string, message: string) {
    this.live.delete(id);
    const session = this.sessions.get(id);
    if (session) {
      this.sessions.set(id, {
        ...session,
        status: 'unknown',
        evidence: 'unavailable',
        attentionKey: null,
        detail: message,
      });
      this.publish();
    }
  }
  private handleMessage(message: Record<string, any>) {
    const params = message.params || {};
    if (message.method === 'client-status-changed' && params.status === 'disconnected') {
      for (const [id, live] of this.live)
        if (live.owner === params.clientId)
          this.invalidate(id, 'The Codex window observing this task disconnected.');
      return;
    }
    if (message.method === 'ipc-connection-reset') {
      for (const id of this.tracked) {
        this.invalidate(id, 'Reconnecting to Codex');
        this.transport.resync(id);
      }
      return;
    }
    const id = params.conversationId || params.threadId;
    if (params.hostId !== 'local' || !this.tracked.includes(id)) return;
    if (message.method === 'thread-read-state-changed' && message.version === 3) {
      const live = this.live.get(id);
      if (live && typeof params.hasUnreadTurn === 'boolean') {
        live.state = { ...live.state, hasUnreadTurn: params.hasUnreadTurn };
        this.publishLive(id, live);
      }
      return;
    }
    if (message.method !== 'thread-stream-state-changed') return;
    if (message.version !== 11) {
      this.protocolError = `Unsupported Codex stream version ${message.version}; expected 11.`;
      this.invalidate(id, 'This Codex desktop protocol version is not supported.');
      this.health('degraded', this.protocolError);
      return;
    }
    const change = params.change;
    try {
      const old = this.live.get(id);
      if (!change || !Number.isSafeInteger(change.revision))
        throw new Error('Missing Codex state revision.');
      if (change.type === 'snapshot') {
        if (old && old.owner === message.sourceClientId && change.revision < old.revision) return;
        if (change.conversationState?.id !== id)
          throw new Error('Codex snapshot identity mismatch.');
        this.protocolError = null;
        const live = {
          revision: change.revision,
          owner: String(message.sourceClientId),
          state: projectConversation(change.conversationState),
        };
        this.live.set(id, live);
        this.publishLive(id, live);
      } else if (change.type === 'patches') {
        if (old && old.owner === message.sourceClientId && change.revision <= old.revision) return;
        if (!old || old.owner !== message.sourceClientId || change.baseRevision !== old.revision)
          throw new Error('Missed a Codex state update; resynchronizing.');
        const live = {
          ...old,
          revision: change.revision,
          state: patchProjection(old.state, change.patches),
        };
        this.live.set(id, live);
        this.publishLive(id, live);
      } else throw new Error('Unknown Codex state message.');
    } catch (error) {
      this.invalidate(id, error instanceof Error ? error.message : String(error));
      if (Date.now() - (this.resyncTimes.get(id) || 0) > 2000) {
        this.resyncTimes.set(id, Date.now());
        this.transport.resync(id);
      }
    }
  }
  private publishLive(id: string, live: { state: Projection }) {
    const base = this.sessions.get(id);
    if (!base) return;
    this.lastObservedAt = Date.now();
    this.sessions.set(id, sessionFromProjection(base, live.state, this.lastObservedAt));
    this.publish();
  }
  sessionUrl(externalId: string) {
    if (!validThreadId(externalId)) throw new Error('Invalid Codex task id.');
    return `codex://threads/${encodeURIComponent(externalId)}`;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.transport.stop();
  }
}
