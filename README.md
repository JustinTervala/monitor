# Monitor

A local Mac control plane for ongoing AI work. Keep using Codex; Monitor watches your existing sessions, preserves workstream priority, and opens the originating task.

The first implementation is **Codex-only**. Claude has an independent [adapter handoff](docs/claude-handoff.md).

## Run

Requires macOS, Node 24+, and Codex desktop running with local tasks. No API key or extra agent harness.

```sh
npm ci
npm run dev
```

For the production build:

```sh
npm run build
npm start
```

Create a local Mac application with `npm run package:mac`. It writes `out/Monitor-macos-arm64.zip` (or `x64` on an Intel Mac). Extract **Monitor.app** into `~/Applications` or `/Applications` and open it. The bundle is assembled outside synced folders and signed ad hoc for local use; notarized distribution is not configured.

The renderer reloads during development. Restart `npm run dev` after changing main-process or provider code. Close the window to keep observing in the menu bar; **Quit Monitor** stops observation.

## Use

- All non-archived tasks in the local Codex catalog appear automatically, including tasks created while Monitor is running. There is no import step or task-count limit. Discovery refreshes every five seconds.
- Select a row to inspect its tasks. **Open in Codex** opens that exact task.
- Drag a row onto another row and name the combined workstream. One group occupies one row.
- Drag the **⠿ handle** to reorder. The **Priority** view shows the global order across sections; arrow buttons in details provide keyboard-accessible ordering.
- **Edit group** changes its name or project tag. **Detach** splits out a member. Use group snoozing to put a workstream aside.
- Existing groups, names, snoozes, and priority survive discovery and upgrades. Newly discovered tasks start as single-task rows at the end of your saved priority order.
- Snooze the whole workstream for an hour, until tomorrow at 9 AM local time, or until restored. Members keep executing and notifications pause.

Section precedence is **Needs review → Running → Status unavailable → Read**; Snoozed overrides placement. Relative priority remains stable across all these states. There is no task-status editor. Codex owns execution state and read receipts.

## Notifications

Newly observed completions, input requests, approvals, and errors can produce native macOS notifications. Clicking opens the originating task. Notifications are on by default and can be toggled in the toolbar; macOS permission and Focus settings still apply.

Use **Monitor → Test notification** to check native delivery on your Mac.

Use the packaged app for native notification testing: Electron requires a valid app signature on current macOS notification APIs. `npm run dev` is for UI development. See [Electron's notification requirements](https://www.electronjs.org/docs/latest/tutorial/notifications#macos).

Initial snapshots and reconnection backlogs are quiet. Result/request identities are persisted to suppress duplicates. Snooze expiry does not replay notifications for work that finished while snoozed. A task that finishes while already read in Codex may notify but remains in Read.

## Integration limits

This release observes **local Codex desktop sessions**, not cloud/remote tasks or arbitrary CLI processes. It reads catalog metadata from Codex's SQLite database and subscribes as a non-owning follower to the desktop's local IPC stream. It never resumes tasks, sends prompts, answers approvals, or changes Codex settings.

The desktop observer protocol is **internal**, tested against desktop `26.903.61454`, stream version `11`. It may change with app updates. Unsupported or disconnected state becomes **Status unavailable**, never an invented completion. A catalog entry alone is insufficient to know whether a task is running; open it in Codex if no desktop window currently supplies live state.

Codex's socket sends conversation snapshots. The adapter immediately reduces them to metadata, runtime state, and result/request identities. Prompts, responses, and tool payloads are not persisted or sent to the renderer. Monitor's own state lives in its Electron user-data directory in `monitor.sqlite`.

## Development

Stack: **Electron + React + TypeScript + Vite + SQLite** (`node:sqlite`).

```sh
npm run check        # TypeScript, behavioral tests, production build
npm run smoke        # Actual Electron UI, isolated fake Codex socket/database
npm run probe:codex  # Read-only live probe of all discovered local tasks
npm run probe:codex -- TASK_ID
```

The smoke test creates temporary source and Monitor databases; it does not edit your real queue. Its screenshot is saved to `.runtime/smoke.png`.

See [architecture](docs/architecture.md), [product behavior](docs/product-spec.md), [Codex integration](docs/codex-integration.md), and the [Claude handoff](docs/claude-handoff.md).
