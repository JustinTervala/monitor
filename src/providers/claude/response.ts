import { join } from 'node:path';
import type { Session } from '../../shared/types';
import { boundedResponse, responseTail } from '../completed-response';
import { readDesktopRecords, readHookSessions, validCliSessionId } from './catalog';

export async function readClaudeResponse(
  desktopDir: string,
  configDir: string,
  hooksDir: string,
  session: Session,
): Promise<string | null> {
  const id = session.resumeId;
  if (!id || !validCliSessionId(id) || !session.directory) return null;
  let assistantId: string | null = null;
  let completedAt: number | null = null;
  if (session.externalId.startsWith('cli_')) {
    const hook = readHookSessions(hooksDir).get(id);
    if (!hook?.result || hook.result.error || hook.result.key !== session.attentionKey) return null;
    completedAt = hook.result.at;
  } else {
    const record = readDesktopRecords(desktopDir).find((r) => r.sessionId === session.externalId);
    if (
      !record ||
      record.archived ||
      record.cliSessionId !== id ||
      !record.lastAssistantUuid ||
      record.completedTurns <= 0 ||
      `result:${record.completedTurns}` !== session.attentionKey ||
      record.lastActivityAt !== session.activityAt
    )
      return null;
    assistantId = record.lastAssistantUuid;
  }
  const project = session.directory.replace(/[^a-zA-Z0-9]/g, '-');
  const records = (await responseTail(join(configDir, 'projects', project, `${id}.jsonl`))).filter(
    (v) => v.sessionId === id && v.isSidechain !== true && ['user', 'assistant'].includes(v.type),
  );
  const last = records.at(-1);
  if (!last || last.type !== 'assistant' || (assistantId && last.uuid !== assistantId)) return null;
  if (completedAt !== null) {
    const at = Date.parse(last.timestamp);
    if (!Number.isFinite(at) || at > completedAt + 2000 || completedAt - at > 10 * 60 * 1000)
      return null;
  }
  // Exclude reasoning and tool calls, and refuse an unfinished tool-use response.
  if (last.message?.stop_reason !== 'end_turn' || !Array.isArray(last.message?.content))
    return null;
  return boundedResponse(
    last.message.content
      .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
      .map((c: any) => c.text)
      .join('\n'),
  );
}
