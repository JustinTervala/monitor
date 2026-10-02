import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LineageReader } from '../src/providers/lineage';
import { readCatalog } from '../src/providers/codex/catalog';
import { ClaudeProvider } from '../src/providers/claude';
import type { Session } from '../src/shared/types';

test('Codex catalog reduces fork metadata, handles shared history, and never persists transcript content', (t) => {
  const home = mkdtempSync('/tmp/monitor-lineage-');
  t.after(() => rmSync(home, { recursive: true }));
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER,created_at INTEGER,rollout_path TEXT)',
  );
  for (const [id, fields] of [
    ['root00', {}],
    ['fork01', { forked_from_id: 'root00' }],
    ['fork02', { history_base: { thread_id: 'fork01', end_ordinal_exclusive: 5 } }],
    ['agent0', { parent_thread_id: 'root00' }],
    ['bad000', { forked_from_id: 'bad000' }],
  ] as const) {
    const path = join(home, `${id}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          ...fields,
          base_instructions: { text: 'SECRET PROMPT' },
          dynamic_tools: [{ description: 'SECRET TOOL' }],
        },
      }) +
        '\n' +
        JSON.stringify({ type: 'response_item', payload: { text: 'SECRET RESPONSE' } }) +
        '\n',
    );
    db.prepare("INSERT INTO threads VALUES(?,?,'/work','cli',0,100,50,?)").run(id, id, path);
  }
  db.close();
  const source = readFileSync(join(home, 'state_5.sqlite'));
  const tasks = readCatalog(home);
  assert.deepEqual(tasks.find((s) => s.externalId === 'root00')?.lineage, { parentId: null });
  assert.deepEqual(tasks.find((s) => s.externalId === 'fork01')?.lineage, {
    parentId: 'codex:root00',
  });
  assert.deepEqual(tasks.find((s) => s.externalId === 'fork02')?.lineage, {
    parentId: 'codex:fork01',
  });
  assert.deepEqual(tasks.find((s) => s.externalId === 'agent0')?.lineage, { parentId: null });
  assert.equal(tasks.find((s) => s.externalId === 'bad000')?.lineage, undefined);
  assert.equal(tasks[0].createdAt, 50000);
  assert.doesNotMatch(JSON.stringify(tasks), /SECRET|base_instructions|dynamic_tools|end_ordinal/);
  assert.deepEqual(readFileSync(join(home, 'state_5.sqlite')), source);
});

test('prefix reader retries partial metadata, caches only reduced values, notices replacement, and bounds scans', (t) => {
  const home = mkdtempSync('/tmp/monitor-prefix-');
  t.after(() => rmSync(home, { recursive: true }));
  const path = join(home, 'session.jsonl'),
    reader = new LineageReader();
  let calls = 0;
  const parse = (value: any) => {
    calls++;
    return value.type === 'metadata' ? { parent: value.parent } : undefined;
  };
  writeFileSync(path, '{"type":"metadata","parent":');
  assert.equal(reader.read(path, 'session', parse), undefined);
  appendFileSync(path, '"parent-a"}\n');
  assert.deepEqual(reader.read(path, 'session', parse), { parent: 'parent-a' });
  appendFileSync(path, 'SECRET TRANSCRIPT\n');
  assert.deepEqual(reader.read(path, 'session', parse), { parent: 'parent-a' });
  assert.equal(calls, 1);
  writeFileSync(join(home, 'new.jsonl'), '{"type":"metadata","parent":"parent-b"}\n');
  renameSync(join(home, 'new.jsonl'), path);
  assert.deepEqual(reader.read(path, 'session', parse), { parent: 'parent-b' });
  writeFileSync(
    join(home, 'huge.jsonl'),
    'x'.repeat(1024 * 1024) + '\n{"type":"metadata","parent":"past-limit"}\n',
  );
  assert.equal(reader.read(join(home, 'huge.jsonl'), 'huge', parse), undefined);
  assert.equal(reader.read(home, 'directory', parse), undefined);
});

test('Claude desktop and CLI forks resolve across surfaces and honor source detachment', async (t) => {
  const root = mkdtempSync('/tmp/monitor-claude-forks-');
  const desktop = join(root, 'desktop'),
    org = join(desktop, 'account', 'org'),
    config = join(root, 'config'),
    hooks = join(root, 'hooks');
  mkdirSync(org, { recursive: true });
  mkdirSync(join(config, 'sessions'), { recursive: true });
  mkdirSync(hooks);
  const a = '00000000-0000-4000-8000-000000000001',
    b = '00000000-0000-4000-8000-000000000002',
    c = '00000000-0000-4000-8000-000000000003';
  const record = (id: string, fields: object) =>
    writeFileSync(
      join(org, `${id}.json`),
      JSON.stringify({ sessionId: id, cwd: '/work/project', createdAt: 1000, ...fields }),
    );
  record(`local_${a}`, { cliSessionId: a });
  record(`local_${b}`, {
    cliSessionId: b,
    forkedFromSessionId: `local_${a}`,
    forkedAtMessageUuid: c,
    postTurnSummary: 'SECRET RESPONSE',
  });
  writeFileSync(join(hooks, `${c}.start`), `v=1\nentrypoint=cli\ncwd=/work/project\nat=1000\n`);
  const project = join(config, 'projects', '-work-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${c}.jsonl`),
    JSON.stringify({
      type: 'user',
      sessionId: c,
      message: { content: 'SECRET PROMPT' },
      forkedFrom: { sessionId: a, messageUuid: b },
    }) + '\n',
  );
  let sessions: Session[] = [];
  const provider = new ClaudeProvider({
    desktopDir: desktop,
    configDir: config,
    hooksDir: hooks,
    desktopRunning: async () => true,
    pollMs: 60000,
  });
  t.after(() => {
    provider.stop();
    rmSync(root, { recursive: true });
  });
  await provider.start({
    sessions: (value) => {
      sessions = value;
    },
    health: () => {},
  });
  assert.deepEqual(sessions.find((s) => s.externalId === `local_${b}`)?.lineage, {
    parentId: `claude:local_${a}`,
  });
  assert.deepEqual(sessions.find((s) => s.externalId === `cli_${c}`)?.lineage, {
    parentId: `claude:local_${a}`,
  });
  assert.doesNotMatch(JSON.stringify(sessions), /SECRET|messageUuid|forkedAtMessageUuid/);
  record(`local_${b}`, {
    cliSessionId: b,
    forkedFromSessionId: `local_${a}`,
    lineageDetached: true,
  });
  await provider.refresh();
  assert.deepEqual(sessions.find((s) => s.externalId === `local_${b}`)?.lineage, {
    parentId: null,
  });
});
