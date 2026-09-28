import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../../shared/types';

export const validThreadId = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(id);
export function findStateDatabase(home: string): string {
  const names = readdirSync(home).filter((name) => /^state_\d+\.sqlite$/.test(name));
  names.sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]));
  if (!names[0])
    throw new Error('No Codex session database found. Open Codex and create a local task first.');
  return join(home, names[0]);
}

export function readCatalog(home: string, tracked: string[] = []): Session[] {
  const db = new DatabaseSync(findStateDatabase(home), { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
    const columns = new Set(
      (db.prepare('PRAGMA table_info(threads)').all() as Array<{ name: string }>).map(
        (row) => row.name,
      ),
    );
    for (const required of ['id', 'title', 'cwd', 'source', 'archived', 'updated_at'])
      if (!columns.has(required))
        throw new Error(`Unsupported Codex database: missing ${required}.`);
    const projection = `id, title, cwd, source, archived, updated_at${columns.has('name') ? ', name' : ''}${columns.has('updated_at_ms') ? ', updated_at_ms' : ''}`;
    const rows = db
      .prepare(
        `SELECT ${projection} FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 200`,
      )
      .all();
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const get = db.prepare(`SELECT ${projection} FROM threads WHERE id=?`);
    for (const id of tracked) {
      if (!byId.has(id)) {
        const row = get.get(id);
        if (row) byId.set(id, row);
      }
    }
    const now = Date.now();
    return [...byId.values()]
      .filter((row) => validThreadId(String(row.id)) && !String(row.source).includes('subagent'))
      .map((row) => ({
        id: `codex:${row.id}`,
        provider: 'codex',
        externalId: String(row.id),
        title: String(row.name || row.title || 'Untitled Codex task').slice(0, 500),
        directory: row.cwd ? String(row.cwd) : null,
        status: 'unknown',
        detail: 'Waiting for a live state from Codex',
        updatedAt: Number(row.updated_at_ms) || Number(row.updated_at) * 1000,
        observedAt: now,
        evidence: 'unavailable',
        attentionKey: null,
        archived: Boolean(row.archived),
      }));
  } finally {
    db.close();
  }
}
