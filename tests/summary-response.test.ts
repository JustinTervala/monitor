import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readCodexResponse } from '../src/providers/codex/response';
import { readClaudeResponse } from '../src/providers/claude/response';
import { session } from './helpers';

const uuid = '00000000-0000-4000-8000-000000000001';
const assistant = '00000000-0000-4000-8000-000000000002';
const jsonl = (values: unknown[]) => values.map((v) => JSON.stringify(v)).join('\n') + '\n';
test('Codex lazily reads only the exact final answer and refuses a newer or interrupted turn', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-codex-response-'));
  t.after(() => rmSync(root, { recursive: true }));
  const file = join(root, 'rollout.jsonl'),
    db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT, archived INTEGER)');
  db.prepare('INSERT INTO threads VALUES(?,?,0)').run('aaaaaa', file);
  const records = [
    { type: 'session_meta', payload: { id: 'aaaaaa' } },
    { type: 'response_item', payload: { role: 'user', content: 'PRIVATE PROMPT' } },
    {
      type: 'response_item',
      payload: { role: 'assistant', phase: 'commentary', content: 'Working' },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn1', last_agent_message: 'Done, PR #324.' },
    },
  ];
  const s = session('aaaaaa', { attentionKey: 'result:turn1' });
  writeFileSync(file, jsonl(records));
  assert.equal(await readCodexResponse(root, s), 'Done, PR #324.');
  assert.equal(await readCodexResponse(root, { ...s, attentionKey: 'result:older' }), null);
  for (const type of ['task_started', 'turn_aborted']) {
    writeFileSync(
      file,
      jsonl([...records, { type: 'event_msg', payload: { type, turn_id: 'turn2' } }]),
    );
    assert.equal(await readCodexResponse(root, s), null);
  }
  writeFileSync(file, jsonl(records));
  db.prepare('UPDATE threads SET archived=1').run();
  assert.equal(await readCodexResponse(root, s), null);
  db.close();
});

test('Claude matches the desktop completion and final message; reasoning and tools stay out', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-claude-response-'));
  t.after(() => rmSync(root, { recursive: true }));
  const desktop = join(root, 'desktop'),
    config = join(root, 'config'),
    hooks = join(root, 'hooks');
  const dir = '/work/project',
    activityAt = Date.now();
  mkdirSync(join(desktop, 'account', 'org'), { recursive: true });
  mkdirSync(join(config, 'projects', '-work-project'), { recursive: true });
  const recordFile = join(desktop, 'account', 'org', 'local_test.json');
  const record = {
    sessionId: 'local_test',
    cliSessionId: uuid,
    cwd: dir,
    completedTurns: 3,
    lastAssistantUuid: assistant,
    lastActivityAt: activityAt,
  };
  writeFileSync(recordFile, JSON.stringify(record));
  const file = join(config, 'projects', '-work-project', `${uuid}.jsonl`);
  const response = {
    type: 'assistant',
    sessionId: uuid,
    uuid: assistant,
    timestamp: new Date(activityAt).toISOString(),
    message: {
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'PRIVATE REASONING' },
        { type: 'text', text: 'Needs a decision on auth.' },
      ],
    },
  };
  writeFileSync(
    file,
    jsonl([{ type: 'user', sessionId: uuid, message: 'PRIVATE PROMPT' }, response]),
  );
  const s = session('local_test', {
    provider: 'claude',
    resumeId: uuid,
    directory: dir,
    attentionKey: 'result:3',
    activityAt,
  });
  assert.equal(await readClaudeResponse(desktop, config, hooks, s), 'Needs a decision on auth.');
  assert.equal(
    await readClaudeResponse(desktop, config, hooks, { ...s, attentionKey: 'result:2' }),
    null,
  );
  writeFileSync(file, jsonl([{ ...response, uuid: 'not-the-completed-message' }]));
  assert.equal(await readClaudeResponse(desktop, config, hooks, s), null);
  writeFileSync(file, jsonl([response, { type: 'user', sessionId: uuid, message: 'NEW PROMPT' }]));
  assert.equal(await readClaudeResponse(desktop, config, hooks, s), null);
  writeFileSync(
    file,
    jsonl([{ ...response, message: { ...response.message, stop_reason: 'tool_use' } }]),
  );
  assert.equal(await readClaudeResponse(desktop, config, hooks, s), null);
  writeFileSync(recordFile, JSON.stringify({ ...record, isArchived: true }));
  assert.equal(await readClaudeResponse(desktop, config, hooks, s), null);
});

test('Claude terminal final answer must match the current successful hook and its time', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-terminal-response-'));
  t.after(() => rmSync(root, { recursive: true }));
  const config = join(root, 'config'),
    hooks = join(root, 'hooks');
  mkdirSync(join(config, 'projects', '-work-project'), { recursive: true });
  mkdirSync(hooks);
  const at = Date.now(),
    file = join(config, 'projects', '-work-project', `${uuid}.jsonl`);
  writeFileSync(join(hooks, `${uuid}.result`), `v=1\nat=${at}\nprompt=turn3\nkind=result\n`);
  const response = {
    type: 'assistant',
    sessionId: uuid,
    timestamp: new Date(at - 100).toISOString(),
    message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }] },
  };
  writeFileSync(file, jsonl([response]));
  const s = session(`cli_${uuid}`, {
    provider: 'claude',
    resumeId: uuid,
    directory: '/work/project',
    attentionKey: 'result:turn3',
  });
  assert.equal(await readClaudeResponse(root, config, hooks, s), 'Done.');
  assert.equal(
    await readClaudeResponse(root, config, hooks, { ...s, attentionKey: 'result:old' }),
    null,
  );
  writeFileSync(file, jsonl([{ ...response, timestamp: new Date(at + 3000).toISOString() }]));
  assert.equal(await readClaudeResponse(root, config, hooks, s), null);
});
