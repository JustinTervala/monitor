# Architecture

The first implementation uses Electron, React, TypeScript, Vite, and Node's built-in SQLite. All privileged observation runs in the Electron main process. The renderer has a context-isolated, sandboxed preload bridge with validated product commands.

```text
Codex catalog + desktop IPC → CodexProvider ─┐
                                           ├→ MonitorService → SQLite
Future Claude observer     → SessionProvider┘       │
                                                     ├→ native notifications
                                                     └→ snapshots → React queue
```

## Source map

- `src/shared/types.ts`: provider-owned Session, user-owned TaskGroup, Snapshot, and command contracts.
- `src/shared/queue.ts`: pure group precedence, project tags, membership, and ordering operations.
- `src/providers/provider.ts`: provider contract for observation, tracking, health, and session navigation.
- `src/providers/codex/`: catalog reader, framed IPC transport, transcript-free projection, ordered patch reconciliation.
- `src/main/service.ts`: discovery, tracking, durable user state, snooze timers, and notification deduplication.
- `src/main/store.ts`: Monitor's SQLite storage. A single versioned JSON document is updated transactionally; a relational schema can follow when query volume warrants it.
- `src/main/main.ts`: window/menu-bar lifecycle, native notifications, validated navigation and IPC.
- `src/renderer/`: grouped queue, priority view, detail pane, and editors.

## Authority and persistence

Adapters own session status. UI commands own grouping, manual names, project overrides, global order, notification preferences, and snooze deadlines. No command can set a session's runtime state or read receipt.

Discovery automatically admits every nonarchived source task, without a one-time seed limit or a manual import command. New tasks append to the queue; later refreshes do not replace existing groups. This also fills previously unimported tasks when upgrading an older initialized store.

The `groups` array is the persistent total priority order. Section rendering filters that array without reordering it. A merge inherits the higher position and retains the drop target's identity, project override, and snooze policy. Detaching creates an active singleton immediately after the source group.

Monitor stores no transcript bodies. On launch, cached session states become unavailable until corroborated by the provider. Groups, order, and snoozes survive restarts. Source files are read-only; only Monitor's own database is written.

## Notifications

Result and request identities, rather than wall-clock observations, identify attention events. The first valid observation establishes a baseline without notifying. Later live results notify once per session/event. Receipts are written before requesting native delivery, so a crash cannot replay the same delivery; a crash or OS suppression can instead lose a notification. This is an at-most-once policy, not a delivery guarantee.

Suppressed results are also receipted. Snoozes, notification toggles, reconnects, and restart do not create a notification backlog. Snooze expiry only restores placement according to current member states and saved priority.

Closing a window hides it. Explicit Quit stops providers and flushes state. Monitoring while the app is quit, batching notifications across sessions, notarized distribution, and automatic updating are later work.

## Integration contract

See [Codex integration](codex-integration.md) for protocol versions and limitations and [Claude handoff](claude-handoff.md) for the independent adapter task.
