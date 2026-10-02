import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSummary, summarizeWithLuna } from '../src/main/summaries/luna';

test('summary output is bounded and structured', () => {
  assert.equal(parseSummary('{"summary":"Done,  PR #324.\\n"}'), 'Done, PR #324.');
  for (const value of [
    'not json',
    '{}',
    '{"summary":""}',
    '{"summary":12}',
    '{"summary":"Done.","response":"raw"}',
    JSON.stringify({ summary: 'x'.repeat(361) }),
  ])
    assert.equal(parseSummary(value), null);
});
test('worker passes source text only through stdin and uses ephemeral isolated Luna with hooks disabled', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'monitor-fake-luna-')),
    cli = join(root, 'codex');
  const previous = process.env.MONITOR_CODEX_EXECUTABLE;
  t.after(() => {
    rmSync(root, { recursive: true });
    if (previous === undefined) delete process.env.MONITOR_CODEX_EXECUTABLE;
    else process.env.MONITOR_CODEX_EXECUTABLE = previous;
  });
  process.env.MONITOR_CODEX_EXECUTABLE = cli;
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs=require('fs'),assert=require('assert/strict');
const args=process.argv.slice(2), source='SYNTHETIC PRIVATE RESPONSE';
assert(!args.join(' ').includes(source));
for(const flag of ['--ephemeral','--ignore-user-config','--ignore-rules','--json'])assert(args.includes(flag));
assert.equal(args[args.indexOf('--model')+1],'gpt-6-luna');
assert(args.includes('history={persistence="none"}'));assert(args.includes('project_doc_max_bytes=0'));
assert.equal(args[args.indexOf('--sandbox')+1],'read-only');
for(const feature of ['hooks','shell_tool','apps','multi_agent','memories'])assert(args.includes(feature));
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
assert.equal(JSON.parse(input).response,source);
for(const file of fs.readdirSync(process.cwd()))assert(!fs.readFileSync(file,'utf8').includes(source));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:'Done, PR #324.'})}}));
console.log(JSON.stringify({type:'turn.completed'}));
});
`,
    { mode: 0o700 },
  );
  assert.equal(
    await summarizeWithLuna('SYNTHETIC PRIVATE RESPONSE', new AbortController().signal),
    'Done, PR #324.',
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(await summarizeWithLuna('SYNTHETIC PRIVATE RESPONSE', controller.signal), null);
});

test('active worker cancellation terminates the process and removes its temporary runtime', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { setTimeout: delay } = await import('node:timers/promises');
  const root = mkdtempSync(join(tmpdir(), 'monitor-luna-cancel-')),
    cli = join(root, 'codex'),
    marker = join(root, 'started.json');
  const previous = process.env.MONITOR_CODEX_EXECUTABLE;
  t.after(() => {
    rmSync(root, { recursive: true });
    if (previous === undefined) delete process.env.MONITOR_CODEX_EXECUTABLE;
    else process.env.MONITOR_CODEX_EXECUTABLE = previous;
  });
  process.env.MONITOR_CODEX_EXECUTABLE = cli;
  writeFileSync(
    cli,
    `#!${process.execPath}
const fs=require('fs');process.stdin.resume();process.stdin.on('end',()=>{
fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));
setInterval(()=>{},1000);
});
`,
    { mode: 0o700 },
  );
  const controller = new AbortController(),
    result = summarizeWithLuna('Synthetic response.', controller.signal);
  for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(10);
  assert.ok(existsSync(marker));
  const { pid, cwd } = JSON.parse(readFileSync(marker, 'utf8'));
  controller.abort();
  assert.equal(await result, null);
  assert.equal(existsSync(cwd), false);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});
