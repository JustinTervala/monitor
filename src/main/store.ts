import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState } from '../shared/queue';
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
      value.version !== 1 ||
      !Array.isArray(value.groups) ||
      !value.sessions ||
      !value.notificationKeys
    )
      throw new Error('Monitor database format is not supported. Your data has been preserved.');
    // Older releases seeded only 20 tasks once. Admission is now continuous.
    delete value.initialized;
    // Existing workstreams stay in the queue on upgrade.
    for (const group of value.groups) group.archived ??= false;
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
