import type { Session } from './types';

const cliSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Resume the exact local task in its project directory using its native CLI.
 */
export function resumeCommand(session: Session): string | null {
  if (!session.resumeId || !cliSessionId.test(session.resumeId)) return null;
  const resume =
    session.provider === 'codex'
      ? `codex resume ${session.resumeId}`
      : `claude --resume ${session.resumeId}`;
  return session.directory?.startsWith('/') && !/[\0\n\r]/.test(session.directory)
    ? `cd ${shellQuote(session.directory)} && ${resume}`
    : resume;
}

export function canResumeInTerminal(session: Session): boolean {
  return (
    !!resumeCommand(session) &&
    !session.terminalPid &&
    session.status !== 'running' &&
    (session.provider === 'codex'
      ? session.terminalResumeAllowed === true
      : session.openable === false)
  );
}
