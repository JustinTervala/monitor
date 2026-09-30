import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeTty, resumeInITerm, showInITerm, type Run } from '../src/main/iterm';

function fake(responses: Record<string, string | Error>) {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec: Run = async (file, args) => {
    calls.push({ file, args });
    const out = responses[file];
    if (out instanceof Error) throw out;
    return out ?? '';
  };
  return { calls, exec };
}

test('the tty comes from ps and must belong to a Claude process', async () => {
  const brew = fake({ '/bin/ps': 'ttys004  /opt/homebrew/Caskroom/claude-code/2.1.197/claude' });
  assert.equal(await claudeTty(4242, brew.exec), '/dev/ttys004');
  assert.deepEqual(brew.calls[0].args, ['-o', 'tty=,comm=', '-p', '4242']);
  const native = fake({ '/bin/ps': 'ttys012 /Users/me/.local/share/claude/versions/2.1.284' });
  assert.equal(await claudeTty(7, native.exec), '/dev/ttys012');
  // A reused pid, a process without a terminal, or an exited one is rejected.
  await assert.rejects(claudeTty(7, fake({ '/bin/ps': 'ttys004 /usr/bin/vim' }).exec), /no longer/);
  await assert.rejects(
    claudeTty(7, fake({ '/bin/ps': '??  /usr/local/bin/claude' }).exec),
    /no longer/,
  );
  await assert.rejects(
    claudeTty(7, fake({ '/bin/ps': new Error('exit 1') }).exec),
    /no longer running/,
  );
  await assert.rejects(claudeTty(1, fake({}).exec), /Invalid/);
});

test('show passes the tty as an AppleScript argument and reports a missing tab', async () => {
  const ok = fake({ '/bin/ps': 'ttys004 claude', '/usr/bin/osascript': 'shown' });
  await showInITerm(4242, ok.exec);
  const script = ok.calls[1];
  assert.equal(script.args[0], '-e');
  assert.match(script.args[1], /application id "com\.googlecode\.iterm2"/);
  assert.doesNotMatch(script.args[1], /ttys004/, 'values are never interpolated into the script');
  assert.equal(script.args[2], '/dev/ttys004');
  const tmux = fake({ '/bin/ps': 'ttys004 claude', '/usr/bin/osascript': 'missing' });
  await assert.rejects(showInITerm(4242, tmux.exec), /tmux/);
  const denied = fake({
    '/bin/ps': 'ttys004 claude',
    '/usr/bin/osascript': new Error(
      'execution error: Not authorized to send Apple events to iTerm. (-1743)',
    ),
  });
  await assert.rejects(showInITerm(4242, denied.exec), /Privacy & Security → Automation/);
});

test('resume writes the validated command into a new tab via argv', async () => {
  const command = "cd '/w/it'\\''s' && claude --resume 00000000-0000-4000-8000-000000000001";
  const ok = fake({ '/usr/bin/osascript': 'resumed' });
  await resumeInITerm(command, ok.exec);
  assert.equal(ok.calls[0].args[2], command);
  assert.match(ok.calls[0].args[1], /create tab with default profile/);
  assert.doesNotMatch(ok.calls[0].args[1], /claude --resume/);
  await assert.rejects(resumeInITerm('claude --resume x\nrm -rf ~', ok.exec), /Invalid/);
  assert.equal(ok.calls.length, 1);
});
