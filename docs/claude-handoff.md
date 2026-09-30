# Claude adapter handoff

> Implemented in `src/providers/claude/`. See [Claude integration](claude-integration.md) for findings, state mapping, limitations, and verification.

Implement Claude's side of Monitor while keeping the user's existing Claude harnesses. Codex support, scheduling policy, persistence, notifications, and the Electron UI already exist.

## Read first

- `src/providers/provider.ts`: the interface to implement.
- `src/shared/types.ts`: `Session` and `ProviderHealth`.
- `src/main/service.ts`: notification policy and tracking lifecycle.
- `docs/product-spec.md`: accepted interaction model.
- `src/providers/codex/`: reference for observation/reconnect behavior; its internal transport is Codex-specific.

## Implementation scope

Add `src/providers/claude/` with a class implementing `SessionProvider`, `id = 'claude'`. Register it beside `new CodexProvider()` in `src/main/main.ts`. No replacement Claude harness, auto-prompting, or cross-agent handoff is needed.

`start(callbacks)` automatically discovers all nonarchived sessions and emits observations/health, including sessions created later. Do not require manual import or impose a recent-task count limit; paginate the source catalog when necessary. The service admits newly discovered sessions automatically, preserving existing workstream priority. `track(externalIds)` receives the automatically admitted tasks to follow live. `refresh()` reconciles source state; `stop()` releases every watcher/socket/timer. `sessionUrl(externalId)` returns a verified exact-session URI. The main process currently accepts only `codex:` and `claude:`; add a narrowly validated official destination if Claude requires another form. Never pass an arbitrary source-provided URL directly to the shell.

Emit globally namespaced ids (`claude:<source-id>`) with stable `externalId`. Include title, full source directory or null, source timestamps in milliseconds, status, detail, evidence, archived flag, and stable `attentionKey`.

- `running`: affirmative current execution evidence.
- `review`: unread result, approval/input request, or actionable error.
- `read`: reliable acknowledgment evidence and no active execution.
- `unknown`: observation unavailable or insufficient. Do not guess based on file age or assume missing process means success.
- `evidence: live`: currently corroborated observation; historical results alone must not trigger notifications.
- `attentionKey`: stable result or request identity, unchanged across repeat observations and read/unread toggles. Return result identity even when already read so a just-finished foreground task can still notify. Null when no trustworthy identity exists.

Do not emit `live` idle observations before result identity has loaded if it can be avoided. On disconnection emit unavailable task states and offline provider health; on reconnect establish a new baseline. Never store prompt, response, tool arguments, or credentials in Session.

## User model to preserve

All discovered nonarchived tasks appear automatically; there is no Add Task or Remove from Monitor control. New tasks append to the saved global priority order. One row per group. Group status follows the highest member state. Group names are manual; project tags derive only when full source directories agree. Priority is one persistent global order. Only groups can be snoozed. Individual task states have no user editor. Source read receipts stay authoritative.

Groups can also be archived locally in Monitor and browsed on a separate page by project and source recency. `TaskGroup.archived` is independent of provider-owned `Session.archived`. Monitor archive/restore never changes source apps. Archived memberships remain followed and must not be reimported into the queue; supply accurate source `updatedAt` values rather than poll timestamps.

The service owns notification suppression, deduplication, persistence, archive placement, and snooze policy. Keep those policies out of the adapter. A Claude result arriving in a snoozed or archived mixed-provider group must remain quiet while its observed state updates.

## Determine explicitly

Identify whether the installed app exposes Claude Code tasks, normal chats, or both. Confirm supported hooks/APIs before reading undocumented local stores. Verify hook continuations, stop/error semantics, app restart, and exact-session navigation. Ordinary Claude chat must not silently be represented as a Claude Code session.

If read receipts or exact navigation are unavailable, report that limitation explicitly; do not add a status dropdown to conceal it. No changes to the user's Claude settings or hook configuration without reviewing whether their existing authorization covers that integration.

## Acceptance

Add isolated adapter tests and a read-only live probe. Demonstrate an existing task moving through running, attention/completion, and acknowledgment as supported, plus reconnect behavior and exact-session opening. Share which paths were observed live versus fixture-tested. Run `npm run check` and `npm run smoke` before pushing directly to main. This is a personal project with no PR review workflow.
