import type { ProviderHealth, ProviderId, Session } from '../shared/types';

export interface ObserverCallbacks {
  sessions(sessions: Session[]): void;
  health(health: ProviderHealth): void;
}

/** Add a provider here without changing queue state, persistence or the renderer. */
export interface SessionProvider {
  readonly id: ProviderId;
  start(callbacks: ObserverCallbacks): Promise<void>;
  /** Follow all sessions admitted automatically by discovery. */
  track(externalIds: string[]): void;
  refresh(): Promise<void>;
  /** Return a validated navigation URL. Never send a prompt or resume execution. */
  sessionUrl(externalId: string): string;
  /** Lazy, transient final-response read for this exact completion. Never cache the response. */
  readCompletedResponse?(session: Session): Promise<string | null>;
  stop(): void;
}
