import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionProvider, ObserverCallbacks } from '../provider';
import type { Session } from '../../shared/types';
import {
  isAgentProcess,
  readTerminalProcesses,
  sameTerminal,
  type TerminalProcess,
} from '../terminal';
import { readCatalog, validThreadId } from './catalog';
import { CodexTransport } from './transport';
import { LineageReader } from '../lineage';
import { readCodexResponse } from './response';
import { defaultHooksDirectory, readHookRecords, sessionFromHooks, type HookRecord } from './hooks';
import {
  projectConversation,
  patchProjection,
  sessionFromProjection,
  latestTurn,
  type Projection,
} from './projection';

export class CodexProvider implements SessionProvider {
  readonly id = 'codex' as const;
  readCompletedResponse(session: Session) {
    return readCodexResponse(this.home, session);
  }
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
  private hookRecords = new Map<string, HookRecord>();
  private startedAt = Date.now();
  private terminalProcesses: Map<number, TerminalProcess> | null = new Map();
  private terminalOwners = new Map<number, string>();
  private refreshPromise: Promise<void> | null = null;
  private lineage = new LineageReader();
  constructor(
    readonly home = process.env.CODEX_HOME || join(homedir(), '.codex'),
    readonly hooksDirectory = defaultHooksDirectory(),
    private readProcesses = readTerminalProcesses,
  ) {
    this.transport = new CodexTransport(join(home, 'ipc', 'ipc.sock'));
  }
  async start(callbacks: ObserverCallbacks) {
    this.callbacks = callbacks;
    this.startedAt = Date.now();
    callbacks.health({
      provider: this.id,
      state: 'connecting',
      message: 'Connecting to local Codex',
      lastObservedAt: null,
    });
    await this.refresh();
    this.transport.on('ready', () => {
      this.connected = true;
      this.reportHealth();
    });
    this.transport.on('offline', (message: string) => {
      this.connected = false;
      this.live.clear();
      for (const [id, s] of this.sessions)
        this.sessions.set(
          id,
          this.withHooks({
            ...s,
            status: 'unknown',
            evidence: 'unavailable',
            attentionKey: null,
            awaitingInput: false,
            detail: 'Codex desktop disconnected; last known state is not current',
          }),
        );
      this.publish();
      this.reportHealth(message);
    });
    this.transport.on('message', (message) => this.handleMessage(message));
    this.transport.start();
    this.timer = setInterval(() => void this.refresh(), 1000);
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
  private withHooks(session: Session, projection?: Projection) {
    const record = this.hookRecords.get(session.externalId);
    const terminal = record?.terminal;
    const process = terminal && this.terminalProcesses?.get(terminal.pid);
    const alive =
      terminal &&
      !terminal.ended &&
      process &&
      isAgentProcess(process.command, 'codex') &&
      sameTerminal(terminal, process) &&
      this.terminalOwners.get(terminal.pid) === session.externalId;
    const desktopBusy =
      projection &&
      (projection.threadRuntimeStatus?.type === 'active' ||
        projection.requests?.length ||
        projection.threadRuntimeStatus?.activeFlags?.length ||
        latestTurn(projection)?.status === 'inProgress');
    session = {
      ...session,
      resumeId: terminal ? session.externalId : null,
      terminalPid: alive ? terminal.pid : null,
      terminalIdentity: alive
        ? { pid: terminal.pid, tty: terminal.tty, startedAt: terminal.startedAt }
        : null,
      terminalResumeAllowed:
        !!terminal && this.terminalProcesses !== null && !alive && !desktopBusy,
    };
    const event = record?.activity?.turnId ? record.activity : record?.completion;
    const turn = projection && latestTurn(projection);
    const oldIdleTurn =
      projection &&
      ['idle', 'notLoaded'].includes(projection.threadRuntimeStatus?.type || '') &&
      !projection.requests?.length &&
      !projection.threadRuntimeStatus?.activeFlags?.length &&
      event?.turnId &&
      event.turnId !== (turn?.turnId || turn?.id) &&
      event.at > (Number(turn?.turnStartedAtMs) || 0);
    // A desktop receipt for an older turn cannot acknowledge newer CLI/plugin work.
    return session.status === 'unknown' || oldIdleTurn
      ? sessionFromHooks(
          { ...session, status: 'unknown', evidence: 'unavailable', attentionKey: null },
          record,
          this.startedAt,
        )
      : session;
  }
  private reportHealth(offlineMessage = 'Codex desktop disconnected') {
    const hasHooks = [...this.sessions.values()].some((s) => {
      const record = this.hookRecords.get(s.externalId);
      return record?.activity || record?.completion;
    });
    if (this.connected && !this.protocolError) {
      this.health(
        'live',
        `Connected to Codex desktop${hasHooks ? ' · companion observations available' : ''}`,
      );
    } else {
      this.health(
        hasHooks ? 'degraded' : 'offline',
        `${this.protocolError || offlineMessage}${hasHooks ? ' · using companion observations; read receipts unavailable' : ''}`,
      );
    }
  }
  refresh(): Promise<void> {
    if (!this.refreshPromise)
      this.refreshPromise = this.refreshNow().finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }
  private async refreshNow() {
    try {
      this.hookRecords = readHookRecords(this.hooksDirectory);
      this.terminalProcesses = await this.readProcesses(
        [...this.hookRecords.values()].flatMap((record) =>
          record.terminal ? [record.terminal.pid] : [],
        ),
      );
      this.terminalOwners.clear();
      // /new can keep the CLI process alive. Only its most recent task owns its tab.
      for (const [id, record] of [...this.hookRecords].sort(
        (a, b) => (a[1].terminal?.at || 0) - (b[1].terminal?.at || 0),
      )) {
        if (record.terminal) this.terminalOwners.set(record.terminal.pid, id);
      }
      const rows = readCatalog(this.home, this.tracked, this.lineage);
      for (const row of rows) {
        const live = this.live.get(row.externalId);
        this.sessions.set(
          row.externalId,
          this.withHooks(live ? sessionFromProjection(row, live.state) : row, live?.state),
        );
      }
      this.publish();
      this.reportHealth();
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
      this.sessions.set(
        id,
        this.withHooks({
          ...session,
          status: 'unknown',
          evidence: 'unavailable',
          attentionKey: null,
          awaitingInput: false,
          detail: message,
        }),
      );
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
    this.sessions.set(
      id,
      this.withHooks(sessionFromProjection(base, live.state, this.lastObservedAt), live.state),
    );
    this.publish();
  }
  sessionUrl(externalId: string) {
    if (!validThreadId(externalId)) throw new Error('Invalid Codex task id.');
    return `codex://threads/${encodeURIComponent(externalId)}`;
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.callbacks = null;
    this.transport.stop();
  }
}
