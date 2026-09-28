import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type Socket } from 'node:net';
import { readCatalog } from '../src/providers/codex/catalog';
import { CodexProvider } from '../src/providers/codex';
import { FrameDecoder, encodeFrame } from '../src/providers/codex/transport';
import type { Session } from '../src/shared/types';

function catalog(home: string) {
  const db = new DatabaseSync(join(home, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER);
    INSERT INTO threads VALUES('aaaaaa','Build feature','/work/project','cli',0,10),('bbbbbb','Helper','/work/project','subagent',0,11);`);
  db.close();
}
test('catalog only reads source metadata and does not infer runtime from recency', () => {
  const home = mkdtempSync('/tmp/monitor-cat-');
  try {
    catalog(home);
    const before = readFileSync(join(home, 'state_5.sqlite'));
    const sessions = readCatalog(home);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, 'unknown');
    assert.equal(sessions[0].attentionKey, null);
    assert.equal(sessions[0].updatedAt, 10000);
    assert.deepEqual(readFileSync(join(home, 'state_5.sqlite')), before);
  } finally {
    rmSync(home, { recursive: true });
  }
});
test('desktop observer follows, applies ordered patches, resyncs gaps and never claims ownership', async (t) => {
  const home = mkdtempSync('/tmp/monitor-ipc-');
  mkdirSync(join(home, 'ipc'), { mode: 0o700 });
  catalog(home);
  let client: Socket | undefined;
  const outbound: any[] = [];
  const server = createServer((socket) => {
    client = socket;
    const decoder = new FrameDecoder();
    socket.on('data', (bytes) => {
      for (const raw of decoder.push(bytes)) {
        const message = raw as any;
        outbound.push(message);
        if (message.method === 'initialize')
          socket.write(
            encodeFrame({
              type: 'response',
              requestId: message.requestId,
              resultType: 'success',
              result: { clientId: 'observer' },
            }),
          );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(home, 'ipc', 'ipc.sock'), resolve));
  const provider = new CodexProvider(home);
  let sessions: Session[] = [];
  t.after(async () => {
    provider.stop();
    client?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true });
  });
  provider.track(['aaaaaa']);
  await provider.start({
    sessions: (value) => {
      sessions = value;
    },
    health: () => {},
  });
  async function wait(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail('Timed out waiting for observer');
  }
  const send = (value: unknown) => client!.write(encodeFrame(value));
  const update = (change: object, version = 11) =>
    send({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version,
      sourceClientId: 'owner',
      params: { hostId: 'local', conversationId: 'aaaaaa', change },
    });
  await wait(() => outbound.some((m) => m.method === 'thread-stream-following-changed'));
  send({ type: 'client-discovery-request', requestId: 'discover' });
  await wait(() => outbound.some((m) => m.type === 'client-discovery-response'));
  assert.deepEqual(outbound.find((m) => m.type === 'client-discovery-response').response, {
    canHandle: false,
  });
  update({
    type: 'snapshot',
    revision: 1,
    conversationState: {
      id: 'aaaaaa',
      threadRuntimeStatus: { type: 'active' },
      hasUnreadTurn: false,
      turns: [{ turnId: 'turn1', status: 'inProgress', turnStartedAtMs: 1 }],
    },
  });
  await wait(() => sessions[0]?.status === 'running');
  update({
    type: 'patches',
    baseRevision: 1,
    revision: 2,
    patches: [
      { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } },
      { op: 'replace', path: ['hasUnreadTurn'], value: true },
    ],
  });
  await wait(() => sessions[0]?.status === 'review');
  assert.equal(sessions[0].attentionKey, 'result:turn1');
  send({
    type: 'broadcast',
    method: 'thread-read-state-changed',
    version: 3,
    params: { hostId: 'local', threadId: 'aaaaaa', hasUnreadTurn: false },
  });
  await wait(() => sessions[0]?.status === 'read');
  update({ type: 'patches', baseRevision: 5, revision: 6, patches: [] });
  await wait(() => sessions[0]?.status === 'unknown');
  await wait(() =>
    outbound.some((m) => m.method === 'thread-stream-following-changed' && !m.params.following),
  );
  update({
    type: 'snapshot',
    revision: 7,
    conversationState: { id: 'aaaaaa', threadRuntimeStatus: { type: 'active' } },
  });
  await wait(() => sessions[0]?.status === 'running');
  update({ type: 'patches', baseRevision: 7, revision: 8, patches: [] }, 99);
  await wait(() => sessions[0]?.status === 'unknown');
  assert.match(sessions[0].detail, /not supported/);
  assert.ok(
    outbound.every(
      (m) =>
        m.method === 'initialize' ||
        m.method === 'thread-stream-following-changed' ||
        m.type === 'client-discovery-response',
    ),
  );
});
