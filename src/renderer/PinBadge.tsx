import type { Session } from '../shared/types';

export function PinBadge({ sessions }: { sessions: Session[] }) {
  const count = sessions.filter((s) => s.provider === 'codex' && s.sourcePinned === true).length;
  if (!count) return null;
  const label = count === 1 ? 'Pinned in Codex' : `${count} conversations pinned in Codex`;
  return (
    <span className="pin-badge" role="img" aria-label={label} title={label}>
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m16 3 5 5-4 1-3 5v3l-7-7h3l5-3zM9 15l-6 6" />
      </svg>
      Pinned{count > 1 && ` · ${count}`}
    </span>
  );
}
