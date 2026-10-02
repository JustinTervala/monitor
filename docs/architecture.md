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
- `src/shared/forks.ts`: stable source-ancestry families, missing-parent placeholders, cycle handling, and iterative branch traversal independent of groups.
- `src/providers/lineage.ts`: bounded source-prefix reader that caches only reduced parent identifiers.
- `src/providers/provider.ts`: provider contract for observation, tracking, health, and session navigation.
- `src/providers/codex/`: catalog reader, framed IPC transport, transcript-free projection, ordered patch reconciliation, and supported companion observations when desktop state is unavailable.
- `src/providers/claude/`: desktop Code-session record reader, Claude Code process registry, focus-based acknowledgment projection.
- `src/main/service.ts`: discovery, tracking, durable user state, snooze timers, and notification deduplication.
- `src/main/store.ts`: Monitor's SQLite storage. A single versioned JSON document is updated transactionally; a relational schema can follow when query volume warrants it.
- `src/main/main.ts`: window/menu-bar lifecycle, native notifications, validated navigation and IPC.
- `src/renderer/`: grouped queue, priority view, project/recency Library and archive, detail pane, and editors.
- `src/renderer/TaskView.tsx`: cross-group task navigation, fork tree, branch focus/collapse, expanded view, and individual task assignment.

## Authority and persistence

Adapters own session status. UI commands own grouping, manual names, project overrides, global order, notification preferences, snooze deadlines, and Monitor archive placement. No command can set a session's runtime state, source archive flag, or read receipt.

Discovery indexes every nonarchived source task. `TaskGroup.inQueue` controls attention-queue membership; Library includes every group. New discoveries start queued if their source activity is within seven days or live observation confirms running/input-waiting. Older discoveries start in Library. Actual provider `activityAt` advancing beyond the persisted observation baseline, or a currently running/waiting state, promotes a library group. Catalog timestamp changes and read-receipt backfill alone do not. This is admission, not rolling eviction.

The `groups` array remains the persistent total priority order, including library and archived entries. Queue rendering filters `inQueue && !archived` without changing order. `archived` records explicit intent, is distinct from source `Session.archived`, and blocks automatic promotion and notifications. Restoring sets queue membership and clears archive; archiving clears snooze. All memberships remain tracked, so no rediscovery duplicates a group. Project/recency browsing never mutates saved priority.

The service's renderer snapshot excludes source-archived Codex sessions and their membership entries, omitting groups with no visible members. Group projections also ignore those sessions for status, name, project, and recency. Persistent state retains the full membership and order, so unarchiving in Codex restores placement. Hidden sessions cannot promote groups or notify; their suppressed results are still receipted. Tracking starts before the first provider catalog read to pick up tasks archived while Monitor was closed. Claude source-archive behavior is unchanged.

The one-time version-1 to version-2 data upgrade keeps all groups, sessions, names, membership, priority, snoozes, archives, and notification receipts. Older unnamed singletons enter Library. Named/grouped workstreams, custom projects, and snoozes retain queue membership. Version 2 persists each task's first observation, latest actual activity timestamp, and qualified last-known status separately from provider-owned sessions.

A merge inherits the higher position and retains the drop target's identity, project override, and snooze policy. Detaching creates a singleton immediately after the source group; it stays archived if its parent was archived. Archived groups must be restored before merging, reordering, or snoozing.

Assigning a task moves only that member into the selected group. The destination keeps its priority, snooze, queue, and archive settings. Source peers retain their settings. Empty unnamed singletons are removed; emptied named/custom-project groups retain their saved metadata and remain available in Library and the group picker. Empty groups do not occupy the attention queue. Source ancestry is provider-owned and unaffected by every grouping operation. `Session.lineage` is optional: absence means unavailable, `parentId: null` means no source parent recorded, and a parent ID is namespaced to its provider. No database reset or state-version migration is required.

The fork graph spans all visible tasks, including Monitor archives. Source-hidden or missing parents receive anonymous placeholders that can still connect sibling forks; their names/statuses are not exposed. Siblings sort by source creation time then ID, never status, title, or last activity. Cycles are cut deterministically and flagged. Iterative traversal handles deep chains without recursive stack overflow. Deep rows beyond eight lanes show their level, with explicit parent navigation in details. Runtime states retain the same unavailable/last-known qualification as the queue.

Monitor stores no transcript bodies. On launch, cached session states become unavailable until corroborated by the provider. The separate last-known observation preserves placement and is labeled as historical; it never overwrites the provider status or creates a completion. Groups, order, and snoozes survive restarts. Source files are read-only during observation. Companion hooks also write private metadata records; only the explicit installer updates Codex integration settings.

## Notifications

Result and request identities, rather than wall-clock observations, identify attention events. The first valid observation establishes a baseline without notifying. Later live results notify once per session/event. Receipts are written before requesting native delivery, so a crash cannot replay the same delivery; a crash or OS suppression can instead lose a notification. This is an at-most-once policy, not a delivery guarantee.

Suppressed results are also receipted. Library-only groups, archives, snoozes, notification toggles, reconnects, and restart do not create a notification backlog. Archived groups remain observed. Snooze expiry and explicit archive restoration only restore placement according to current member states and saved priority.

Closing a window hides it. Explicit Quit stops providers and flushes state. Monitoring while the app is quit, batching notifications across sessions, notarized distribution, and automatic updating are later work.

## Integration contract

See [Codex integration](codex-integration.md) for protocol versions and limitations and [Claude integration](claude-integration.md) for the Claude adapter's sources and limits.
