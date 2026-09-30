import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Same shape the desktop's own `claude://code/continue?session=` handler accepts. */
export const validSessionId = (id: string) => /^local_[A-Za-z0-9-]{1,64}$/.test(id);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code's own session id, as accepted by `claude --resume`. */
export const validCliSessionId = (id: string) => uuid.test(id);
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Whitelisted desktop session metadata. Prompts, summaries and error text are never kept. */
export interface DesktopRecord {
  sessionId: string;
  cliSessionId: string | null;
  title: string | null;
  cwd: string | null;
  archived: boolean;
  createdAt: number | null;
  lastActivityAt: number | null;
  lastFocusedAt: number | null;
  lastAssistantUuid: string | null;
  /** Successful turns; incremented once per turn, unlike the per-message uuid. */
  completedTurns: number;
  errorAt: number | null;
}

/** A Claude Code process registered in `<config>/sessions/<pid>.json`. */
export interface LiveProcess {
  pid: number;
  status: 'busy' | 'shell' | 'idle' | 'waiting';
  waitingFor: string | null;
  statusUpdatedAt: number | null;
}

const time = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 4e15 ? value : null;
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);

function readJson(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > MAX_RECORD_BYTES) return null;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    // A record can be mid-write; the next pass reads it again.
    return null;
  }
}

function recordFiles(root: string): string[] {
  // <root>/<account>/<org>/local_<id>.json
  const files: string[] = [];
  const dirs = (path: string) =>
    readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(path, entry.name));
  for (const account of dirs(root))
    for (const org of dirs(account))
      for (const name of readdirSync(org))
        if (/^local_[A-Za-z0-9-]{1,64}\.json$/.test(name)) files.push(join(org, name));
  return files;
}

/** Read every desktop Code-tab session record. Throws only if the store itself is unreadable. */
export function readDesktopRecords(root: string): DesktopRecord[] {
  const byId = new Map<string, DesktopRecord>();
  for (const file of recordFiles(root)) {
    const raw = readJson(file);
    const sessionId = raw?.sessionId;
    if (!raw || typeof sessionId !== 'string' || !validSessionId(sessionId)) continue;
    const assistant = raw.lastAssistantUuid;
    const record: DesktopRecord = {
      sessionId,
      cliSessionId:
        typeof raw.cliSessionId === 'string' && uuid.test(raw.cliSessionId)
          ? raw.cliSessionId
          : null,
      title: text(raw.title)?.slice(0, 500) ?? null,
      cwd: text(raw.cwd),
      archived: raw.isArchived === true,
      createdAt: time(raw.createdAt),
      lastActivityAt: time(raw.lastActivityAt),
      lastFocusedAt: time(raw.lastFocusedAt),
      lastAssistantUuid: typeof assistant === 'string' && uuid.test(assistant) ? assistant : null,
      completedTurns:
        Number.isSafeInteger(raw.completedTurns) && (raw.completedTurns as number) > 0
          ? (raw.completedTurns as number)
          : 0,
      errorAt: raw.error !== undefined && raw.error !== null ? time(raw.errorAt) : null,
    };
    const old = byId.get(sessionId);
    if (!old || (record.lastActivityAt ?? 0) > (old.lastActivityAt ?? 0))
      byId.set(sessionId, record);
  }
  return [...byId.values()];
}

export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A terminal (`claude` CLI) process; it has no desktop record. */
export interface TerminalProcess extends LiveProcess {
  sessionId: string;
  cwd: string | null;
  name: string | null;
}

export interface LiveProcesses {
  /** Keyed by desktop `local_` session id. */
  desktop: Map<string, LiveProcess>;
  /** Keyed by Claude Code session uuid. */
  terminal: Map<string, TerminalProcess>;
}

/** Newest live process per session. Dead, headless and malformed entries are ignored. */
export function readLiveProcesses(
  registry: string,
  alive: (pid: number) => boolean = processAlive,
): LiveProcesses {
  const out: LiveProcesses = { desktop: new Map(), terminal: new Map() };
  let names: string[];
  try {
    names = readdirSync(registry);
  } catch {
    return out;
  }
  const newer = (old: LiveProcess | undefined, entry: LiveProcess) =>
    !old || (entry.statusUpdatedAt ?? 0) > (old.statusUpdatedAt ?? 0);
  for (const name of names) {
    const match = /^(\d{1,10})\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const raw = readJson(join(registry, name));
    if (!raw || raw.pid !== pid) continue;
    const status = raw.status;
    if (status !== 'busy' && status !== 'shell' && status !== 'idle' && status !== 'waiting')
      continue;
    const host = raw.hostSessionId,
      session = raw.sessionId;
    const desktop = typeof host === 'string' && validSessionId(host);
    const terminal =
      !desktop &&
      raw.entrypoint === 'cli' &&
      raw.kind === 'interactive' &&
      typeof session === 'string' &&
      uuid.test(session);
    if ((!desktop && !terminal) || !alive(pid)) continue;
    const entry: LiveProcess = {
      pid,
      status,
      // The CLI writes a short fixed phrase here, e.g. "permission prompt" or "input needed".
      waitingFor:
        typeof raw.waitingFor === 'string' && /^[a-z ]{1,40}$/.test(raw.waitingFor)
          ? raw.waitingFor
          : null,
      statusUpdatedAt: time(raw.statusUpdatedAt),
    };
    if (desktop) {
      if (newer(out.desktop.get(host), entry)) out.desktop.set(host, entry);
    } else if (newer(out.terminal.get(session as string), entry))
      out.terminal.set(session as string, {
        ...entry,
        sessionId: session as string,
        cwd: text(raw.cwd),
        name: text(raw.name)?.slice(0, 200) ?? null,
      });
  }
  return out;
}

/** What the monitor-hooks plugin recorded for one terminal session. */
export interface HookSession {
  sessionId: string;
  entrypoint: string | null;
  cwd: string | null;
  title: string | null;
  startedAt: number | null;
  result: { at: number; key: string; error: boolean } | null;
  endedAt: number | null;
}

function readHookFile(path: string): Record<string, string> | null {
  try {
    if (statSync(path).size > 64 * 1024) return null;
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out.v === '1' ? out : null;
  } catch {
    return null;
  }
}

/** Read `<dir>/<session>.{start,result,end}` files written by plugins/monitor-hooks. */
export function readHookSessions(dir: string): Map<string, HookSession> {
  const out = new Map<string, HookSession>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  const token = (value: string | undefined) =>
    value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
  for (const name of names) {
    const match = /^([0-9a-fA-F-]{36})\.(start|result|end)$/.exec(name);
    if (!match || !uuid.test(match[1])) continue;
    const raw = readHookFile(join(dir, name));
    const at = time(Number(raw?.at));
    if (!raw || !at) continue;
    const id = match[1].toLowerCase();
    const session: HookSession = out.get(id) ?? {
      sessionId: id,
      entrypoint: null,
      cwd: null,
      title: null,
      startedAt: null,
      result: null,
      endedAt: null,
    };
    session.entrypoint ??= token(raw.entrypoint);
    if (raw.cwd?.startsWith('/')) session.cwd ??= raw.cwd;
    if (match[2] === 'start') {
      session.startedAt = at;
      session.title = text(raw.title)?.slice(0, 200) ?? null;
    } else if (match[2] === 'end') session.endedAt = at;
    else {
      const error = raw.kind === 'error';
      // prompt_id identifies the turn; the write time is the fallback identity.
      const turn = token(raw.prompt) ?? String(at);
      session.result = { at, key: `${error ? 'error' : 'result'}:${turn}`, error };
    }
    out.set(id, session);
  }
  return out;
}
