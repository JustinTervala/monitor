import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeFrame } from '../src/providers/codex/transport';
import {
  projectConversation,
  patchProjection,
  sessionFromProjection,
} from '../src/providers/codex/projection';
import { session } from './helpers';

test('framing handles arbitrary boundaries and UTF8; rejects oversized frames', () => {
  const values = [{ title: 'hello 🦉' }, { method: 'update' }];
  const data = Buffer.concat(values.map(encodeFrame)),
    decoder = new FrameDecoder(),
    result = [];
  for (const byte of data) result.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(result, values);
  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(100_000_000);
  assert.throws(() => new FrameDecoder().push(huge), /frame size/);
});
test('projection discards transcript and request payloads through snapshots and patches', () => {
  const state = projectConversation({
    id: 'aaaaaa',
    threadRuntimeStatus: { type: 'active', activeFlags: [] },
    hasUnreadTurn: false,
    turns: [],
    turnHistory: {
      history: {
        entitiesByKey: {
          key: { turnId: 'turn1', status: 'inProgress', turnStartedAtMs: 1, items: ['SECRET'] },
        },
      },
    },
    requests: [{ id: 7, method: 'approval', params: 'SECRET' }],
    input: 'SECRET',
  });
  const changed = patchProjection(state, [
    {
      op: 'add',
      path: ['turnHistory', 'history', 'entitiesByKey', 'key', 'items', 1],
      value: 'SECRET',
    },
    {
      op: 'replace',
      path: ['turnHistory', 'history', 'entitiesByKey', 'key', 'status'],
      value: 'completed',
    },
    { op: 'replace', path: ['requests'], value: [] },
    { op: 'replace', path: ['threadRuntimeStatus'], value: { type: 'idle' } },
    { op: 'replace', path: ['hasUnreadTurn'], value: true },
  ]);
  assert.equal(JSON.stringify(changed).includes('SECRET'), false);
  const observed = sessionFromProjection(session('aaaaaa'), changed);
  assert.equal(observed.status, 'review');
  assert.equal(observed.attentionKey, 'result:turn1');
  const read = sessionFromProjection(session('aaaaaa'), { ...changed, hasUnreadTurn: false });
  assert.equal(read.status, 'read');
  assert.equal(read.attentionKey, observed.attentionKey);
  assert.equal(read.activityAt, 1);
  assert.equal(
    sessionFromProjection(session('aaaaaa'), { ...changed, updatedAt: Date.now() }).activityAt,
    1,
  );
});
test('approval outranks running; missing runtime or read receipt stays unknown', () => {
  const base = session('aaaaaa');
  assert.equal(
    sessionFromProjection(base, {
      threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnUserInput'] },
    }).awaitingInput,
    true,
  );
  assert.equal(
    sessionFromProjection(base, {
      threadRuntimeStatus: { type: 'active', activeFlags: ['waitingOnApproval'] },
      requests: [{ id: 9 }],
    }).attentionKey,
    'request:9',
  );
  assert.equal(
    sessionFromProjection(base, { threadRuntimeStatus: { type: 'active' } }).status,
    'running',
  );
  assert.equal(
    sessionFromProjection(base, { threadRuntimeStatus: { type: 'idle' } }).status,
    'unknown',
  );
  assert.equal(sessionFromProjection(base, { hasUnreadTurn: true }).status, 'unknown');
  assert.throws(
    () => patchProjection({}, [{ op: 'add', path: ['__proto__', 'bad'], value: true }]),
    /Unsafe/,
  );
});
