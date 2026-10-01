import { execFile } from 'node:child_process';
import type { ProviderId, TerminalIdentity } from '../shared/types';

export const processColumns = 'pid=,tty=,lstart=,comm=';
export interface TerminalProcess extends TerminalIdentity {
  command: string;
}

/** ps comm excludes command arguments, which can contain prompts or credentials. */
export function parseTerminalProcesses(output: string): Map<number, TerminalProcess> {
  const processes = new Map<number, TerminalProcess>();
  for (const line of output.split('\n')) {
    const match =
      /^\s*(\d+)\s+(ttys\d{1,4})\s+(\S+\s+\S+\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(
        line,
      );
    if (!match) continue;
    const pid = Number(match[1]);
    processes.set(pid, {
      pid,
      tty: `/dev/${match[2]}`,
      startedAt: match[3].replace(/\s+/g, ' '),
      command: match[4],
    });
  }
  return processes;
}

export function isAgentProcess(command: string, provider: ProviderId): boolean {
  return provider === 'codex'
    ? /(?:^|\/)codex(?:-[a-z0-9_-]+)?$/i.test(command)
    : /claude/i.test(command);
}

export function sameTerminal(a: TerminalIdentity, b: TerminalIdentity): boolean {
  return a.pid === b.pid && a.tty === b.tty && a.startedAt === b.startedAt;
}

/** One bounded process lookup per refresh, only for PIDs observed by the companion. */
export async function readTerminalProcesses(
  pids: number[],
): Promise<Map<number, TerminalProcess> | null> {
  const ids = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 1);
  if (!ids.length) return new Map();
  return new Promise((resolve) => {
    execFile(
      '/bin/ps',
      ['-o', processColumns, '-p', ids.join(',')],
      { timeout: 2000 },
      (error, out, stderr) => {
        // ps exits 1 when every requested process has exited; other failures are unknown.
        if (error && (error.code !== 1 || stderr.trim())) resolve(null);
        else resolve(parseTerminalProcesses(out));
      },
    );
  });
}
