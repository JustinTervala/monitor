import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CodexProvider } from '../src/providers/codex';
import { readHookRecords } from '../src/providers/codex/hooks';
import { canResumeInTerminal, resumeCommand } from '../src/shared/resume';
import { parseTerminalProcesses, type TerminalProcess } from '../src/providers/terminal';
import type { Session } from '../src/shared/types';

const id = '00000000-0000-4000-8000-000000000001';
const next = '00000000-0000-4000-8000-000000000002';
const identity = { pid: 4242, tty: '/dev/ttys004', startedAt: 'Thu Oct 1 04:52:11 2026' };

function fixture(t: any) {
  const root = mkdtempSync('/tmp/monitor-codex-terminal-');
  const hooks = join(root, 'hooks');
  mkdirSync(hooks, { mode: 0o700 });
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec(
    'CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,source TEXT,archived INTEGER,updated_at INTEGER)',
  );
  for (const task of [id, next])
    db.prepare("INSERT INTO threads VALUES(?,'Synthetic task','/work/cli','cli',0,10)").run(task);
  db.close();
  const write = (task: string, at: number, event = 'UserPromptSubmit', complete = false) => {
    const observation = { event, turnId: `turn-${task}`, at };
    writeFileSync(
      join(hooks, `${task}.json`),
      JSON.stringify({
        version: 1,
        sessionId: task,
        activity: observation,
        ...(complete ? { completion: { ...observation, event: 'TurnComplete' } } : {}),
        terminal: { ...identity, at, ended: event === 'SessionEnd' },
      }),
      { mode: 0o600 },
    );
  };
  let processes: Map<number, TerminalProcess> | null = new Map([
    [identity.pid, { ...identity, command: '/opt/bin/codex' }],
  ]);
  const provider = new CodexProvider(root, hooks, async () => processes);
  let sessions: Session[] = [];
  t.after(() => {
    provider.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    hooks,
    write,
    provider,
    processes: (value: typeof processes) => {
      processes = value;
    },
    session: (task = id) => sessions.find((s) => s.externalId === task)!,
    start: () =>
      provider.start({
        sessions: (value) => {
          sessions = value;
        },
        health: () => {},
      }),
  };
}

test('CLI tasks keep their desktop identity while iTerm actions follow the live process', async (t) => {
  const f = fixture(t);
  const at = Date.now() - 10;
  f.write(id, at);
  await f.start();
  assert.equal(f.session().status, 'running');
  assert.notEqual(f.session().openable, false);
  assert.equal(f.provider.sessionUrl(id), `codex://threads/${id}`);
  assert.equal(f.session().terminalPid, identity.pid);
  assert.deepEqual(f.session().terminalIdentity, identity);
  assert.equal(canResumeInTerminal(f.session()), false);
  assert.equal(f.session(next).resumeId, null, 'source=cli alone does not imply a terminal task');
  f.write(id, Date.now(), 'Stop', true);
  await f.provider.refresh();
  assert.equal(f.session().status, 'review');
  assert.equal(canResumeInTerminal(f.session()), false, 'idle CLI still owns its terminal');
  f.processes(new Map());
  await f.provider.refresh();
  assert.equal(f.session().terminalPid, null);
  assert.equal(f.session().status, 'review');
  assert.equal(canResumeInTerminal(f.session()), true);
  assert.equal(resumeCommand(f.session()), `cd '/work/cli' && codex resume ${id}`);
  f.processes(null);
  await f.provider.refresh();
  assert.equal(
    canResumeInTerminal(f.session()),
    false,
    'failed process lookup is not proof of exit',
  );
});

test('PID reuse and switching tasks in the same CLI do not focus the wrong task', async (t) => {
  const f = fixture(t);
  f.write(id, Date.now() - 20, 'Stop', true);
  f.write(next, Date.now() - 10);
  await f.start();
  assert.equal(f.session(id).terminalPid, null);
  assert.equal(f.session(next).terminalPid, identity.pid);
  f.processes(
    new Map([
      [identity.pid, { ...identity, startedAt: 'Thu Oct 1 05:00:00 2026', command: 'codex' }],
    ]),
  );
  await f.provider.refresh();
  assert.equal(f.session(next).terminalPid, null);
  f.processes(new Map([[identity.pid, { ...identity, command: '/usr/bin/vim' }]]));
  await f.provider.refresh();
  assert.equal(f.session(next).terminalPid, null);
});

test('the real companion writer binds its Codex ancestor, excludes headless processes, and ignores spoofed payload fields', (t) => {
  const f = fixture(t);
  const code = `
import importlib.util,json,os,subprocess,sys
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('writer',sys.argv[1])
writer=importlib.util.module_from_spec(spec);spec.loader.exec_module(writer)
output='42 4242 ?? Thu Oct  1 04:52:12 2026 /bin/sh\\n4242 1 ttys004 Thu Oct  1 04:52:11 2026 /opt/bin/codex\\n'
payload={'session_id':sys.argv[2], 'hook_event_name':'UserPromptSubmit','turn_id':'turn-123456', 'terminal':{'pid':123}, 'prompt':'secret prompt'}
with patch.object(writer.os,'getppid',return_value=42), patch.object(writer.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output,'')) as ps:
    writer.record(payload)
    assert ps.call_args.args[0] == ['/bin/ps','-A','-o','pid=,ppid=,tty=,lstart=,comm=']
with patch.object(writer.os,'getppid',return_value=42), patch.object(writer.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output.replace('ttys004','??'),'')):
    assert writer.terminal_owner() is None
`;
  const result = spawnSync(
    'python3',
    ['-B', '-c', code, resolve('plugins/monitor-codex/hooks/record.py'), id],
    {
      encoding: 'utf8',
      env: { ...process.env, MONITOR_CODEX_HOOKS_DIR: f.hooks },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const record = readHookRecords(f.hooks).get(id)!;
  assert.deepEqual({ ...record.terminal, at: 0 }, { ...identity, at: 0, ended: false });
  assert.doesNotMatch(readFileSync(join(f.hooks, `${id}.json`), 'utf8'), /secret|prompt|command/);
  const processes = parseTerminalProcesses(
    ' 4242 ttys004 Thu Oct  1 04:52:11 2026 /opt/bin/codex\n77 ?? Thu Oct 1 00:00:00 2026 codex',
  );
  assert.deepEqual(processes.get(4242), { ...identity, command: '/opt/bin/codex' });
  assert.equal(processes.size, 1);
});
