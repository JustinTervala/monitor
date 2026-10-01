import { execFile } from 'node:child_process';
import type { ProviderId, TerminalIdentity } from '../shared/types';
import {
  isAgentProcess,
  parseTerminalProcesses,
  processColumns,
  sameTerminal,
} from '../providers/terminal';

// AppleScript receives every value through `argv`; nothing is interpolated into
// script source, so a path or command cannot change what the script does.
const SHOW = `on run argv
  set target to item 1 of argv
  tell application id "com.googlecode.iterm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is target then
            select w
            tell t to select
            tell s to select
            activate
            return "shown"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "missing"
end run`;

const RESUME = `on run argv
  tell application id "com.googlecode.iterm2"
    activate
    if (count of windows) is 0 then
      set w to (create window with default profile)
    else
      set w to current window
      tell w to create tab with default profile
    end if
    tell current session of w to write text (item 1 of argv)
  end tell
  return "resumed"
end run`;

export type Run = (file: string, args: string[]) => Promise<string>;
const run: Run = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 15_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()),
    ),
  );

function explain(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/-1743|not authori[sz]ed/i.test(message))
    return new Error(
      'Monitor is not allowed to control iTerm2. Allow it in System Settings → Privacy & Security → Automation.',
    );
  if (/-1728|-600|can.t get application/i.test(message))
    return new Error('iTerm2 is not installed or could not be launched.');
  return new Error(`iTerm2 did not respond: ${message}`);
}

/** Resolve the live process again so an exited/reused PID cannot focus another task. */
export async function agentTty(
  pid: number,
  provider: ProviderId,
  identity?: TerminalIdentity | null,
  exec: Run = run,
): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid process id.');
  let out: string;
  try {
    out = await exec('/bin/ps', ['-o', processColumns, '-p', String(pid)]);
  } catch {
    throw new Error('This session is no longer running.');
  }
  const process = parseTerminalProcesses(out).get(pid);
  if (
    !process ||
    !isAgentProcess(process.command, provider) ||
    (identity && !sameTerminal(identity, process))
  )
    throw new Error('This session is no longer running in that terminal.');
  return process.tty;
}

/** Bring the iTerm2 tab running this process to the front. */
export async function showInITerm(
  pid: number,
  provider: ProviderId,
  identity?: TerminalIdentity | null,
  exec: Run = run,
) {
  const tty = await agentTty(pid, provider, identity, exec);
  let result: string;
  try {
    result = await exec('/usr/bin/osascript', ['-e', SHOW, tty]);
  } catch (error) {
    throw explain(error);
  }
  if (result !== 'shown')
    throw new Error('No iTerm2 tab owns this session (it may be running in tmux or another app).');
}

/** Open a new iTerm2 tab and run an already validated resume command in it. */
export async function resumeInITerm(command: string, exec: Run = run) {
  if (/[\0\r\n]/.test(command)) throw new Error('Invalid resume command.');
  try {
    await exec('/usr/bin/osascript', ['-e', RESUME, command]);
  } catch (error) {
    throw explain(error);
  }
}
