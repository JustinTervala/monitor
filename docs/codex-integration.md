# Codex desktop observer

Compatibility inspected on macOS with desktop `26.903.61454` (bundle `com.openai.codex`). This is an experimental adapter to **internal desktop IPC**, not a supported public external-observer API.

## Why this integration

The official app-server provides thread operations for its own server. Starting another server or resuming an existing task there would not provide passive observation of the already-running desktop runtime. Monitor instead follows the existing desktop's state broadcasts. It does not launch an app-server, another agent, or take task ownership.

Official reference: [Codex app-server](https://learn.chatgpt.com/docs/app-server). The observer messages below were verified from the installed desktop and a live read-only connection; that reference does not document or guarantee them.

## Discovery

Use `CODEX_HOME` or `~/.codex`. Open the highest `state_N.sqlite` read-only with `PRAGMA query_only=ON`. Read validated metadata columns from `threads`: identity, title/name, cwd, source, archived, update time. Discover all nonarchived local entries without a recency/count cutoff and explicitly fetch existing group members that have since been archived. These archive observations hide tasks from every Monitor view and suppress notifications while retaining saved membership for unarchiving. Ignore subagent entries. Update every second. Supported [companion observations](codex-companion.md) fill gaps in desktop state; the desktop remains authoritative when it provides supported runtime state and receipts.

A catalog timestamp is not runtime evidence. Catalog-only tasks remain unavailable.

## Desktop transport

Connect to `ipc/ipc.sock` only when it and its parent directory belong to the current OS user and the directory is not writable by other users. Messages are UTF-8 JSON framed by a four-byte unsigned little-endian length. The adapter caps frames at 64 MiB and reconnects with bounded exponential backoff.

Outbound messages are limited to:

1. `initialize` request, version 0, `clientType: monitor-observer`.
2. `thread-stream-following-changed` broadcast, version 1, local host, requested conversation id, `following: true/false`.
3. Discovery responses with **`canHandle: false`**, so Monitor can never claim task ownership.

Inbound state:

- `thread-stream-state-changed`, version **11**, snapshot or Immer patches with revision/baseRevision and source owner.
- `thread-read-state-changed`, version **3**, authoritative `hasUnreadTurn` for a tracked local task.
- Follower-status requests, client disconnects, and connection resets.

Duplicate/old patches are ignored. A revision gap, owner change without a fresh snapshot, invalid patch, or unsupported message makes the task unavailable. Resubscribe after a gap for a fresh snapshot. Loss of the socket or owning desktop window invalidates runtime evidence.

Snapshots can contain transcript content in memory. Immediately project onto id/title/cwd, runtime type/flags, request identifiers/methods, read state, and turn identity/status/start time. Filter patches through the same projection. Persist only the resulting Session fields.

## State mapping

| Source evidence                                                   | Monitor state |
| ----------------------------------------------------------------- | ------------- |
| Pending request or waiting-on-approval/input flag                 | Needs review  |
| Active runtime without pending request                            | Running       |
| System error                                                      | Needs review  |
| Idle/not-loaded with unread receipt                               | Needs review  |
| Idle/not-loaded with read receipt                                 | Read          |
| Missing/unsupported runtime, missing receipt, disconnected source | Unavailable   |

A result identity uses the latest observed turn id; pending attention uses request identity when available. If no stable identity is available, display the state without fabricating a notification event. The most recent result can be read in Codex while the agent is running; active runtime still wins over that older result's receipt.

## Navigation

The installed desktop registers the `codex:` scheme and handles `codex://threads/<id>`. Only validated task identifiers are accepted. No caller-supplied arbitrary URL reaches `shell.openExternal`.

## Verification scope

Behavioral tests cover catalog read-only access, framing, snapshots/patches, source ownership boundaries, revision-gap recovery, unsupported stream versions, grouping/priority/snoozes, event deduplication, and persistence. The Electron smoke test uses the real adapter with an isolated source fixture.

On the development Mac, the live probe and packaged app observed the current running Codex task without a prompt or ownership operation. The packaged UI dispatched its exact `codex://threads/<id>` destination successfully. After signing the generated app bundle, a native test notification emitted Electron's `show` event. The first unsigned build failed, which is why local packaging now signs and verifies the complete bundle.

The OS success event confirms native notification submission, not a visible banner under every Focus/notification setting. Real completion transitions, snooze suppression, duplicate handling, and click routing are fixture-tested; a live agent completion was not induced solely for this test. Historical catalog entries without a loaded desktop runtime remain unavailable. Check native permissions on each target Mac.

Reference: [Electron notification signing requirements](https://www.electronjs.org/docs/latest/tutorial/notifications#macos).
