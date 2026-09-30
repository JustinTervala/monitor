# Architecture

The first implementation uses Electron, React, TypeScript, Vite, and Node's built-in SQLite. All privileged observation runs in the Electron main process. The renderer has a context-isolated, sandboxed preload bridge with validated product commands.

```text
Codex catalog + IPC + hooks → CodexProvider ─┐
                                           ├→ MonitorService → SQLite
Claude desktop records    → ClaudeProvider ┘       │
                                                     ├→ native notifications
                                                     └→ snapshots → React queue
```

## Source map

- `src/shared/types.ts`: provider-owned Session, user-owned TaskGroup, Snapshot, and command contracts.
- `src/shared/queue.ts`: pure group precedence, project tags, membership, and ordering operations.
- `src/providers/provider.ts`: provider contract for observation, tracking, health, and session navigation.
- `src/providers/codex/`: catalog reader, framed IPC transport, transcript-free projection, ordered patch reconciliation, and supported companion observations when desktop state is unavailable.
- `src/providers/claude/`: desktop Code-session record reader, Claude Code process registry, focus-based acknowledgment projection.
- `src/main/service.ts`: discovery, tracking, durable user state, snooze timers, and notification deduplication.
- `src/main/store.ts`: Monitor's SQLite storage. A single versioned JSON document is updated transactionally; a relational schema can follow when query volume warrants it.
- `src/main/main.ts`: window/menu-bar lifecycle, native notifications, validated navigation and IPC.
- `src/renderer/`: grouped queue, priority view, project/recency archive, detail pane, and editors.

## Authority and persistence

Adapters own session status. UI commands own grouping, manual names, project overrides, global order, notification preferences, snooze deadlines, and Monitor archive placement. No command can set a session's runtime state, source archive flag, or read receipt.

Discovery automatically admits every nonarchived source task, without a one-time seed limit or a manual import command. New tasks append to the queue; later refreshes do not replace existing groups. This also fills previously unimported tasks when upgrading an older initialized store.

The `groups` array is the persistent total priority order, including archived workstreams. Queue rendering filters active entries without reordering them. `TaskGroup.archived` is local scheduling metadata, distinct from provider-owned `Session.archived`. Missing group archive fields migrate to `false`. Archiving clears snooze; restoring only clears the group archive flag. Archive project/recency sorting derives a separate view and never mutates priority. The admission deduplication set includes archived memberships so polling cannot recreate them in the queue.

A merge inherits the higher position and retains the drop target's identity, project override, and snooze policy. Detaching creates a singleton immediately after the source group; it stays archived if its parent was archived. Archived groups must be restored before merging, reordering, or snoozing.

Monitor stores no transcript bodies. On launch, cached session states become unavailable until corroborated by the provider. Groups, order, and snoozes survive restarts. Source files are read-only during observation. Companion hooks also write private metadata records; only the explicit installer updates Codex integration settings.

## Notifications

Result and request identities, rather than wall-clock observations, identify attention events. The first valid observation establishes a baseline without notifying. Later live results notify once per session/event. Receipts are written before requesting native delivery, so a crash cannot replay the same delivery; a crash or OS suppression can instead lose a notification. This is an at-most-once policy, not a delivery guarantee.

Suppressed results are also receipted. Archives, snoozes, notification toggles, reconnects, and restart do not create a notification backlog. Archived groups remain observed. Snooze expiry and explicit archive restoration only restore placement according to current member states and saved priority.

Closing a window hides it. Explicit Quit stops providers and flushes state. Monitoring while the app is quit, batching notifications across sessions, notarized distribution, and automatic updating are later work.

## Integration contract

See [Codex integration](codex-integration.md) for protocol versions and limitations and [Claude integration](claude-integration.md) for the Claude adapter's sources and limits.
