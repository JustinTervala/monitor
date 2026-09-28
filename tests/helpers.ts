import type { Session } from '../src/shared/types';
export const session = (id: string, extra: Partial<Session> = {}): Session => ({
  id: `codex:${id}`,
  externalId: id,
  provider: 'codex',
  title: `Task ${id}`,
  directory: '/work/project',
  status: 'running',
  detail: 'Codex is working',
  updatedAt: 1,
  observedAt: 1,
  evidence: 'live',
  attentionKey: null,
  archived: false,
  ...extra,
});
