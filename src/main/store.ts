import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState, RECENT_WINDOW_MS } from '../shared/queue';
import type { MonitorState } from '../shared/types';

export class MonitorStore {
  private db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=2000; CREATE TABLE IF NOT EXISTS monitor_state (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);',
    );
  }
  read(): MonitorState {
    const row = this.db.prepare('SELECT json FROM monitor_state WHERE id=1').get();
    if (!row) return emptyState();
    const value = JSON.parse(String(row.json));
    if (
      ![1, 2].includes(value.version) ||
      !Array.isArray(value.groups) ||
      !value.sessions ||
      !value.notificationKeys
    )
      throw new Error('Monitor database format is not supported. Your data has been preserved.');
    // One-time data upgrade preserves all organization and saved priority slots.
    delete value.initialized;
    value.summaries ??= {};
    if (value.version === 1) {
      const cutoff = Date.now() - RECENT_WINDOW_MS;
      value.observations = {};
      for (const group of value.groups) {
        group.archived ??= false;
        group.inQueue = Boolean(
          group.archived ||
          group.name ||
          group.projectOverride ||
          group.snooze ||
          group.sessionIds.length > 1 ||
          group.sessionIds.some((id: string) => value.sessions[id]?.updatedAt >= cutoff),
        );
      }
      value.version = 2;
    }
    return value as MonitorState;
  }
  write(state: MonitorState) {
    this.db
      .prepare(
        'INSERT INTO monitor_state(id,json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
      )
      .run(JSON.stringify(state));
  }
  close() {
    this.db.close();
  }
}
