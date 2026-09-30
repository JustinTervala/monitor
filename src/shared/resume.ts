import type { Session } from './types';

const cliSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A POSIX shell command that resumes a Claude session in a terminal. Transcripts
 * are local and looked up per project, so it changes to the session directory.
 */
export function resumeCommand(session: Session): string | null {
  if (session.provider !== 'claude' || !session.resumeId || !cliSessionId.test(session.resumeId))
    return null;
  const resume = `claude --resume ${session.resumeId}`;
  return session.directory?.startsWith('/') && !/[\0\n\r]/.test(session.directory)
    ? `cd ${shellQuote(session.directory)} && ${resume}`
    : resume;
}
