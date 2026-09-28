import { CodexProvider } from '../src/providers/codex';
import type { ProviderHealth, Session } from '../src/shared/types';

const requested = process.argv.slice(2);
const provider = new CodexProvider();
let sessions: Session[] = [],
  health: ProviderHealth | undefined,
  following = false;
await provider.start({
  health: (value) => {
    health = value;
  },
  sessions: (value) => {
    sessions = value;
    if (!following && sessions.length) {
      following = true;
      provider.track(requested.length ? requested : sessions.slice(0, 20).map((s) => s.externalId));
    }
  },
});
await new Promise((resolve) => setTimeout(resolve, 5000));
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
