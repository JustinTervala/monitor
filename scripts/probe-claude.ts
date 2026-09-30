import { ClaudeProvider } from '../src/providers/claude';
import type { ProviderHealth, Session } from '../src/shared/types';

// Read-only: reads Claude desktop session metadata and the Claude Code process
// registry. It never writes source files, opens sockets or sends prompts.
const seconds = Number(process.argv[2]) || 0;
const provider = new ClaudeProvider({ pollMs: 1000 });
let sessions: Session[] = [],
  health: ProviderHealth | undefined;
const seen = new Map<string, string>();
await provider.start({
  health: (value) => {
    health = value;
  },
  sessions: (value) => {
    sessions = value;
    provider.track(value.map((s) => s.externalId));
    // With a duration, log each observed state transition while it runs.
    for (const s of value) {
      const state = `${s.status} · ${s.detail} · ${s.attentionKey}`;
      if (seconds && seen.has(s.externalId) && seen.get(s.externalId) !== state)
        console.log(new Date().toISOString(), s.externalId, state);
      seen.set(s.externalId, state);
    }
  },
});
if (seconds) await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
provider.stop();
const live = sessions.filter((s) => s.evidence === 'live');
console.log(
  JSON.stringify(
    {
      health,
      discovered: sessions.length,
      live: live.length,
      statuses: Object.fromEntries(
        ['review', 'running', 'read', 'unknown'].map((status) => [
          status,
          sessions.filter((s) => s.status === status).length,
        ]),
      ),
      // Deliberately exclude titles, directories and transcript content.
      observed: live.map((s) => ({
        id: s.externalId,
        status: s.status,
        detail: s.detail,
        attentionKey: s.attentionKey,
        url: provider.sessionUrl(s.externalId),
      })),
    },
    null,
    2,
  ),
);
if (health?.state !== 'live' || !live.length) process.exitCode = 1;
