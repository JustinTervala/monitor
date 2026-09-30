import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ACTIVITY_LEASE_MS, readHookRecords, sessionFromHooks } from '../src/providers/codex/hooks';
import { session } from './helpers';
import { CodexProvider } from '../src/providers/codex';
import { DatabaseSync } from 'node:sqlite';

const writer = resolve('plugins/monitor-codex/hooks/record.py');
const task = 'task-123456';
const turn = 'turn-123456';
const payload = (event: string, turnId = turn) => ({
  session_id: task,
  hook_event_name: event,
  turn_id: turnId,
  prompt: 'private prompt',
  last_assistant_message: 'private response',
  tool_input: { command: 'secret tool argument' },
  transcript_path: '/private/transcript',
});
function fixture(t: any) {
  const root = mkdtempSync('/tmp/monitor-codex-hooks-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hooks = join(root, 'hooks');
  const env = { ...process.env, MONITOR_CODEX_HOOKS_DIR: hooks };
  const run = (input: object, notify = false, script = writer) => {
    const raw = JSON.stringify(input);
    const result = spawnSync('python3', [script, ...(notify ? ['--notify', raw] : [])], {
      env,
      input: notify ? undefined : raw,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, notify ? '' : '{}\n');
  };
  const complete = (turnId = turn, script = writer) =>
    run(
      {
        type: 'agent-turn-complete',
        'thread-id': task,
        'turn-id': turnId,
        'last-assistant-message': 'private response',
        'input-messages': ['private prompt'],
      },
      true,
      script,
    );
  return { root, hooks, run, complete };
}

test('actual hooks are non-steering, metadata-only; Stop requires independent confirmation', (t) => {
  const f = fixture(t);
  const start = Date.now() - 1;
  const base = session(task, { status: 'unknown', evidence: 'unavailable' });
  f.run(payload('UserPromptSubmit'));
  let record = readHookRecords(f.hooks).get(task);
  assert.equal(sessionFromHooks(base, record, start).status, 'running');
  f.run(payload('Stop'));
  record = readHookRecords(f.hooks).get(task);
  assert.equal(sessionFromHooks(base, record, start).status, 'unknown');
  assert.equal(sessionFromHooks(base, record, start).attentionKey, null);
  f.complete();
  record = readHookRecords(f.hooks).get(task);
  const result = sessionFromHooks(base, record, start);
  assert.equal(result.status, 'review');
  assert.equal(result.attentionKey, `result:${turn}`);
  assert.equal(result.evidence, 'live');
  assert.equal(sessionFromHooks(base, record, Date.now() + 1).evidence, 'history');
  const disk = readFileSync(join(f.hooks, `${task}.json`), 'utf8');
  assert.doesNotMatch(disk, /private|secret|transcript|prompt|assistant|tool_input/);
  const before = disk;
  f.run({ ...payload('PreToolUse'), agent_id: 'subagent' });
  f.run({ ...payload('PreToolUse'), session_id: '../escape' });
  f.run(payload('PermissionRequest')); // No provisional approval notifications.
  assert.equal(readFileSync(join(f.hooks, `${task}.json`), 'utf8'), before);
  f.run(payload('PreToolUse')); // Even same-turn activity supersedes a recorded completion.
  assert.equal(readHookRecords(f.hooks).get(task)?.completion, undefined);
  f.run(payload('SessionEnd'));
  assert.equal(sessionFromHooks(base, readHookRecords(f.hooks).get(task), start).status, 'unknown');
});

test('continuation, late results, interruption, compaction and expired activity do not invent completion', (t) => {
  const f = fixture(t);
  const base = session(task, { status: 'unknown', evidence: 'unavailable' });
  f.run(payload('UserPromptSubmit'));
  f.run(payload('Stop'));
  f.run(payload('UserPromptSubmit', 'turn-234567'));
  f.complete(); // Delayed completion from the prior turn.
  let record = readHookRecords(f.hooks).get(task)!;
  assert.equal(record.completion, undefined);
  assert.equal(sessionFromHooks(base, record, 0).status, 'running');
  f.run({ ...payload('SessionStart'), source: 'compact' });
  assert.deepEqual(readHookRecords(f.hooks).get(task), record);
  assert.equal(
    sessionFromHooks(base, record, 0, Date.now() + ACTIVITY_LEASE_MS + 1).status,
    'unknown',
  );
  f.run(payload('Interrupt', 'turn-234567'));
  record = readHookRecords(f.hooks).get(task)!;
  assert.equal(sessionFromHooks(base, record, 0).attentionKey, 'result:turn-234567');
  f.run(payload('SessionEnd', 'turn-234567'));
  assert.equal(sessionFromHooks(base, readHookRecords(f.hooks).get(task), 0).status, 'unknown');
});

test('malformed, oversized, future, public and symlink records are ignored', (t) => {
  const f = fixture(t);
  f.run(payload('PreToolUse'));
  const file = join(f.hooks, `${task}.json`);
  const good = readFileSync(file);
  writeFileSync(file, 'bad json');
  assert.equal(readHookRecords(f.hooks).size, 0);
  writeFileSync(file, ' '.repeat(16385));
  assert.equal(readHookRecords(f.hooks).size, 0);
  const future = JSON.parse(good.toString());
  future.activity.at = Date.now() + 60000;
  writeFileSync(file, JSON.stringify(future));
  assert.equal(readHookRecords(f.hooks).get(task)?.activity, undefined);
  writeFileSync(file, good);
  chmodSync(file, 0o644);
  assert.equal(readHookRecords(f.hooks).size, 0);
  rmSync(file);
  const other = join(f.root, 'other.json');
  writeFileSync(other, good, { mode: 0o600 });
  symlinkSync(other, file);
  assert.equal(readHookRecords(f.hooks).size, 0);
  // The writer replaces the symlink itself; it never edits the target.
  f.run(payload('PostToolUse'));
  assert.deepEqual(readFileSync(other), good);
  chmodSync(f.hooks, 0o755);
  const before = readFileSync(file);
  f.run(payload('Stop'));
  assert.deepEqual(readFileSync(file), before);
});

test('completion bridge forwards the previous callback exactly once without forwarding hook events', (t) => {
  const f = fixture(t);
  const wrapper = join(f.root, 'record.py');
  cpSync(writer, wrapper);
  const receiver = join(f.root, 'receiver.py');
  const receipt = join(f.root, 'received.jsonl');
  writeFileSync(
    receiver,
    'import sys,json\nwith open(sys.argv[1],"a") as f: f.write(json.dumps(sys.argv[2:])+"\\n")\n',
  );
  writeFileSync(
    join(f.root, 'forward.json'),
    JSON.stringify({ command: ['python3', receiver, receipt, 'literal argument'] }),
  );
  f.run(payload('UserPromptSubmit'), false, wrapper);
  f.complete(turn, wrapper);
  const forwarded = JSON.parse(readFileSync(receipt, 'utf8').trim());
  assert.equal(forwarded[0], 'literal argument');
  assert.equal(JSON.parse(forwarded[1])['turn-id'], turn);
  assert.equal(readFileSync(receipt, 'utf8').trim().split('\n').length, 1);
});

test('provider uses hook state when desktop is absent, with normal catalog discovery and subagent exclusion', async (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(join(f.root, 'state_5.sqlite'));
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER);
    INSERT INTO threads VALUES('${task}','Synthetic task','/work/project','cli',0,10),
    ('subagent-123','Helper','/work/project','subagent',0,11);`);
  db.close();
  f.run(payload('UserPromptSubmit'));
  f.run({ ...payload('PreToolUse'), session_id: 'subagent-123' });
  const provider = new CodexProvider(f.root, f.hooks);
  t.after(() => provider.stop());
  let sessions: ReturnType<typeof session>[] = [];
  await provider.start({
    sessions: (s) => {
      sessions = s;
    },
    health: () => {},
  });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].status, 'running');
  f.run(payload('Stop'));
  await provider.refresh();
  assert.equal(sessions[0].status, 'unknown');
  f.complete();
  await provider.refresh();
  assert.equal(sessions[0].status, 'review');
  assert.equal(sessions[0].attentionKey, `result:${turn}`);
});

test('installer is idempotent, preserves unrelated TOML and callback; uninstall restores it', (t) => {
  const f = fixture(t);
  const configDir = join(f.root, '.codex');
  mkdirSync(configDir);
  const config = join(configDir, 'config.toml');
  const previous = ['previous-notifier', 'literal spaces', 'quote"'];
  const original =
    '# personal settings\nnotify = [\n' +
    previous.map((x) => JSON.stringify(x) + ',\n').join('') +
    '] # multiline\nmodel = "example"\n[features]\nhooks = true\n';
  writeFileSync(config, original);
  const fake = join(f.root, 'codex');
  writeFileSync(
    fake,
    '#!/usr/bin/env python3\nimport os,pathlib,sys\np=pathlib.Path(os.environ["CODEX_HOME"])/"config.toml"\ns=p.read_text()\nmarker="\\n# CLI config edit preserved\\n"\nif marker not in s:p.write_text(s+marker)\n',
  );
  chmodSync(fake, 0o755);
  const install = (uninstall = false) => {
    const p = spawnSync(
      'python3',
      [resolve('scripts/install-codex.py'), '--codex', fake, ...(uninstall ? ['--uninstall'] : [])],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: f.root, CODEX_HOME: configDir },
      },
    );
    assert.equal(p.status, 0, p.stderr);
  };
  install();
  const once = readFileSync(config, 'utf8');
  assert.match(once, /CLI config edit preserved/);
  assert.match(once, /model = "example"/);
  assert.match(once, /hooks = true/);
  const bridge = join(f.root, 'Library/Application Support/Monitor/codex-bridge');
  assert.deepEqual(
    JSON.parse(readFileSync(join(bridge, 'forward.json'), 'utf8')).command,
    previous,
  );
  install();
  assert.equal(readFileSync(config, 'utf8'), once);
  assert.deepEqual(
    JSON.parse(readFileSync(join(bridge, 'forward.json'), 'utf8')).command,
    previous,
  );
  const marketplace = JSON.parse(
    readFileSync(join(f.root, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  assert.equal(marketplace.plugins.length, 1);
  install(true);
  assert.ok(
    readFileSync(config, 'utf8').includes(
      'notify = ' + JSON.stringify(previous).replaceAll(',', ', '),
    ),
  );
  assert.match(readFileSync(config, 'utf8'), /CLI config edit preserved/);
  assert.equal(existsSync(f.hooks), false);
});
