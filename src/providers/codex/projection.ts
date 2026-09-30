import { applyPatches, enablePatches, type Patch } from 'immer';
import type { Session } from '../../shared/types';

enablePatches();
type ObjectValue = Record<string, any>;
export interface Projection extends ObjectValue {
  threadRuntimeStatus?: { type: string; activeFlags?: string[] };
  requests?: Array<{ id?: string | number; requestId?: string; method?: string }>;
  turns?: ObjectValue[];
  turnHistory?: { history?: { entitiesByKey?: Record<string, ObjectValue> } };
}
const turnFields = new Set(['turnId', 'id', 'status', 'turnStartedAtMs']);
const rootFields = new Set([
  'id',
  'title',
  'cwd',
  'updatedAt',
  'hasUnreadTurn',
  'threadRuntimeStatus',
  'requests',
  'turns',
  'turnHistory',
]);
const object = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const turn = (value: unknown) =>
  Object.fromEntries(Object.entries(object(value)).filter(([key]) => turnFields.has(key)));

/** Keep the shape needed for status patches, discarding prompts, tools and transcript text. */
export function projectConversation(value: unknown): Projection {
  const source = object(value);
  const out = Object.fromEntries(
    Object.entries(source).filter(([key]) => rootFields.has(key)),
  ) as Projection;
  out.turns = Array.isArray(source.turns) ? source.turns.map(turn) : [];
  out.requests = Array.isArray(source.requests)
    ? source.requests.map((request: unknown) => {
        const r = object(request);
        return { id: r.id, requestId: r.requestId, method: r.method };
      })
    : [];
  out.turnHistory = {
    history: {
      entitiesByKey: Object.fromEntries(
        Object.entries(object(source.turnHistory?.history?.entitiesByKey)).map(([key, value]) => [
          key,
          turn(value),
        ]),
      ),
    },
  };
  return out;
}

export function patchProjection(state: Projection, raw: unknown): Projection {
  if (!Array.isArray(raw)) throw new Error('Unsupported Codex patch format.');
  const patches: Patch[] = [];
  for (const p of raw) {
    if (!p || !Array.isArray(p.path) || !['add', 'remove', 'replace'].includes(p.op))
      throw new Error('Unsupported Codex patch.');
    const path: Array<string | number> = p.path;
    if (path.some((key) => ['__proto__', 'prototype', 'constructor'].includes(String(key))))
      throw new Error('Unsafe patch path.');
    if (path.length === 0) {
      patches.push({ ...p, value: projectConversation(p.value) });
      continue;
    }
    const root = String(path[0]);
    if (!rootFields.has(root)) continue;
    let value = p.value;
    if (root === 'turns') {
      if (path.length > 3 || (path.length === 3 && !turnFields.has(String(path[2])))) continue;
      if (path.length === 1 && p.op !== 'remove')
        value = Array.isArray(value) ? value.map(turn) : [];
      else if (path.length === 2 && p.op !== 'remove') value = turn(value);
    } else if (root === 'turnHistory') {
      if (path.length > 1 && path[1] !== 'history') continue;
      if (path.length > 2 && path[2] !== 'entitiesByKey') continue;
      if (path.length > 5 || (path.length === 5 && !turnFields.has(String(path[4])))) continue;
      if (p.op !== 'remove') {
        if (path.length === 1) value = projectConversation({ turnHistory: value }).turnHistory;
        if (path.length === 2)
          value = projectConversation({ turnHistory: { history: value } }).turnHistory!.history;
        if (path.length === 3)
          value = Object.fromEntries(Object.entries(object(value)).map(([k, v]) => [k, turn(v)]));
        if (path.length === 4) value = turn(value);
      }
    } else if (root === 'requests') {
      if (
        path.length > 3 ||
        (path.length === 3 && !['id', 'requestId', 'method'].includes(String(path[2])))
      )
        continue;
      if (path.length === 1 && p.op !== 'remove')
        value = projectConversation({ requests: value }).requests;
      if (path.length === 2 && p.op !== 'remove')
        value = projectConversation({ requests: [value] }).requests![0];
    }
    patches.push(p.op === 'remove' ? { op: p.op, path } : { op: p.op, path, value });
  }
  return applyPatches(state, patches);
}

export function latestTurn(state: Projection) {
  const turns = [
    ...(state.turns || []),
    ...Object.values(state.turnHistory?.history?.entitiesByKey || {}),
  ];
  return turns
    .sort((a, b) => (Number(a.turnStartedAtMs) || 0) - (Number(b.turnStartedAtMs) || 0))
    .at(-1);
}

export function sessionFromProjection(base: Session, state: Projection, now = Date.now()): Session {
  const runtime = state.threadRuntimeStatus;
  const flags = runtime?.activeFlags || [];
  const request = state.requests?.[0];
  const latest = latestTurn(state);
  const turnId = latest?.turnId || latest?.id;
  let status: Session['status'] = 'unknown',
    detail = 'Codex has not reported a supported runtime state.',
    attentionKey: string | null = null;
  if (request || flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput')) {
    status = 'review';
    detail =
      flags.includes('waitingOnApproval') || /approval/i.test(request?.method || '')
        ? 'Waiting for approval in Codex'
        : 'Waiting for your input in Codex';
    const requestId = request?.id ?? request?.requestId;
    attentionKey =
      requestId !== undefined
        ? `request:${requestId}`
        : turnId
          ? `waiting:${turnId}:${flags.join(',')}`
          : null;
  } else if (runtime?.type === 'active') {
    status = 'running';
    detail = 'Codex is working';
  } else if (runtime?.type === 'systemError') {
    status = 'review';
    detail = 'Codex reported an error';
    attentionKey = turnId ? `error:${turnId}` : null;
  } else if (runtime?.type === 'idle' || runtime?.type === 'notLoaded') {
    if (typeof state.hasUnreadTurn === 'boolean') {
      status = state.hasUnreadTurn ? 'review' : 'read';
      detail = state.hasUnreadTurn
        ? latest?.status === 'interrupted'
          ? 'Turn interrupted · unread in Codex'
          : latest?.status === 'failed'
            ? 'Turn failed · unread in Codex'
            : 'New response in Codex'
        : 'Read in Codex';
      attentionKey = turnId ? `result:${turnId}` : null;
    } else detail = 'Codex has not supplied a read receipt.';
  }
  return {
    ...base,
    title: typeof state.title === 'string' && state.title.trim() ? state.title : base.title,
    directory: typeof state.cwd === 'string' ? state.cwd : base.directory,
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : base.updatedAt,
    status,
    detail,
    attentionKey,
    observedAt: now,
    evidence: 'live',
  };
}
