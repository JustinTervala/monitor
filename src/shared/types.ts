export type ProviderId = 'codex' | 'claude';
export type SessionStatus = 'review' | 'running' | 'read' | 'unknown';
export type QueueSection = SessionStatus | 'snoozed';

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
  observedAt: number;
  evidence: 'live' | 'history' | 'unavailable';
  /** Stable result/request identity, not an observation timestamp. */
  attentionKey: string | null;
  archived: boolean;
}

export interface TaskGroup {
  id: string;
  name: string | null;
  projectOverride: string | null;
  sessionIds: string[];
  /** null = active; {until:null} = snoozed until explicitly restored. */
  snooze: { until: number | null } | null;
}

export interface MonitorState {
  version: 1;
  initialized: boolean;
  sessions: Record<string, Session>;
  /** Array position is global relative priority, regardless of section. */
  groups: TaskGroup[];
  notifications: boolean;
  notificationKeys: Record<string, string>;
}

export interface ProviderHealth {
  provider: ProviderId;
  state: 'connecting' | 'live' | 'degraded' | 'offline';
  message: string;
  lastObservedAt: number | null;
}

export interface Snapshot {
  state: MonitorState;
  health: ProviderHealth[];
}

export type Command =
  | { type: 'rename'; groupId: string; name: string; projectOverride: string | null }
  | { type: 'merge'; sourceId: string; targetId: string; name: string }
  | { type: 'move'; groupId: string; targetId: string; placement: 'before' | 'after' }
  | { type: 'snooze'; groupId: string; until: number | null }
  | { type: 'unsnooze'; groupId: string }
  | { type: 'track'; sessionId: string }
  | { type: 'remove'; groupId: string }
  | { type: 'detach'; groupId: string; sessionId: string }
  | { type: 'notifications'; enabled: boolean };

export interface MonitorBridge {
  snapshot(): Promise<Snapshot>;
  command(command: Command): Promise<Snapshot>;
  openSession(sessionId: string): Promise<void>;
  refresh(): Promise<void>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;
}

declare global {
  interface Window {
    monitor: MonitorBridge;
  }
}
