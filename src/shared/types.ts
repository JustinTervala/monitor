export type ProviderId = 'codex' | 'claude';
export type SessionStatus = 'review' | 'running' | 'read' | 'unknown';
export type QueueSection = SessionStatus | 'snoozed';

export interface TerminalIdentity {
  pid: number;
  tty: string;
  startedAt: string;
}

/** Provider-owned observation. Never store transcript content here. */
export interface Session {
  id: string;
  provider: ProviderId;
  externalId: string;
  title: string;
  directory: string | null;
  status: SessionStatus;
  detail: string;
  updatedAt: number;
  createdAt?: number;
  /** Source-owned ancestry. Missing means unavailable; null means no recorded parent. */
  lineage?: { parentId: string | null };
  observedAt: number;
  evidence: 'live' | 'history' | 'unavailable';
  /** Stable result/request identity, not an observation timestamp. */
  attentionKey: string | null;
  /** Actual turn activity, not a title edit, focus, or catalog refresh. */
  activityAt?: number;
  awaitingInput?: boolean;
  /** Source-owned flag. Codex-archived tasks are hidden throughout Monitor. */
  archived: boolean;
  /** false when the source app has no exact-session route (e.g. a terminal session). */
  openable?: boolean;
  /** Native CLI session id; never a command string. */
  resumeId?: string | null;
  /** Live agent process in a terminal, for Show in iTerm. */
  terminalPid?: number | null;
  /** Codex process identity, checked again before focusing iTerm. */
  terminalIdentity?: TerminalIdentity | null;
  /** Codex CLI has exited and no active desktop turn is observed. */
  terminalResumeAllowed?: boolean;
}

export interface TaskGroup {
  id: string;
  name: string | null;
  projectOverride: string | null;
  sessionIds: string[];
  /** Monitor-only archive; independent of each source session's archived flag. */
  archived: boolean;
  /** null = active; {until:null} = snoozed until explicitly restored. */
  snooze: { until: number | null } | null;
  /** Automatic queue admission; Library contains the group while any member is visible. */
  inQueue: boolean;
}

export interface MonitorState {
  version: 2;
  sessions: Record<string, Session>;
  /** Array position is global relative priority, regardless of section. */
  groups: TaskGroup[];
  notifications: boolean;
  notificationKeys: Record<string, string>;
  observations: Record<
    string,
    {
      firstSeenAt: number;
      lastActivityAt: number;
      lastKnown?: { status: Exclude<SessionStatus, 'unknown'>; observedAt: number };
    }
  >;
}

export interface ProviderHealth {
  provider: ProviderId;
  state: 'connecting' | 'live' | 'degraded' | 'offline';
  message: string;
  lastObservedAt: number | null;
}

export interface Snapshot {
  homeDirectory: string;
  state: MonitorState;
  health: ProviderHealth[];
}

export type Command =
  | { type: 'rename'; groupId: string; name: string; projectOverride: string | null }
  | { type: 'merge'; sourceId: string; targetId: string; name: string }
  | { type: 'move'; groupId: string; targetId: string; placement: 'before' | 'after' }
  | { type: 'snooze'; groupId: string; until: number | null }
  | { type: 'unsnooze'; groupId: string }
  | { type: 'archive'; groupId: string }
  | { type: 'restore'; groupId: string }
  | { type: 'detach'; groupId: string; sessionId: string }
  | { type: 'assign'; sessionId: string; targetId: string }
  | { type: 'notifications'; enabled: boolean };

export interface MonitorBridge {
  snapshot(): Promise<Snapshot>;
  command(command: Command): Promise<Snapshot>;
  openSession(sessionId: string): Promise<void>;
  /** Copies the validated resume command to the clipboard and returns it. */
  copyResumeCommand(sessionId: string): Promise<string>;
  /** Brings the iTerm2 tab running this session to the front. */
  showInTerminal(sessionId: string): Promise<void>;
  /** Opens a new iTerm2 tab running the session's resume command. */
  resumeInTerminal(sessionId: string): Promise<void>;
  refresh(): Promise<void>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}

declare global {
  interface Window {
    monitor: MonitorBridge;
  }
}
