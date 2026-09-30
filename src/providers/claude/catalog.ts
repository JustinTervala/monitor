import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Same shape the desktop's own `claude://code/continue?session=` handler accepts. */
export const validSessionId = (id: string) => /^local_[A-Za-z0-9-]{1,64}$/.test(id);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;

/** Whitelisted desktop session metadata. Prompts, summaries and error text are never kept. */
export interface DesktopRecord {
  sessionId: string;
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
  hostSessionId: string;
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

/** Newest live process per desktop session. Dead or unrelated registry entries are ignored. */
export function readLiveProcesses(
  registry: string,
  alive: (pid: number) => boolean = processAlive,
): Map<string, LiveProcess> {
  const out = new Map<string, LiveProcess>();
  let names: string[];
  try {
    names = readdirSync(registry);
  } catch {
    return out;
  }
  for (const name of names) {
    const match = /^(\d{1,10})\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const raw = readJson(join(registry, name));
    if (!raw || raw.pid !== pid) continue;
    const host = raw.hostSessionId,
      status = raw.status;
    if (typeof host !== 'string' || !validSessionId(host)) continue;
    if (status !== 'busy' && status !== 'shell' && status !== 'idle' && status !== 'waiting')
      continue;
    if (!alive(pid)) continue;
    const entry: LiveProcess = {
      pid,
      hostSessionId: host,
      status,
      // The CLI writes a short fixed phrase here, e.g. "permission prompt" or "input needed".
      waitingFor:
        typeof raw.waitingFor === 'string' && /^[a-z ]{1,40}$/.test(raw.waitingFor)
          ? raw.waitingFor
          : null,
      statusUpdatedAt: time(raw.statusUpdatedAt),
    };
    const old = out.get(host);
    if (!old || (entry.statusUpdatedAt ?? 0) > (old.statusUpdatedAt ?? 0)) out.set(host, entry);
  }
  return out;
}
