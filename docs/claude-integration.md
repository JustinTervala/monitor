# Claude desktop observer

Compatibility was inspected on macOS with Claude desktop `2.16120.0` (bundle `com.anthropic.claudefordesktop`) and its bundled Claude Code CLI `2.1.284`. Like the Codex adapter, this is a read-only observer of **undocumented local stores**, not a supported public API.

## What is observable

| Claude surface                | Local state                                                  | Represented                           |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------- |
| Desktop **Code** tab sessions | `claude-code-sessions/<account>/<org>/local_<id>.json`       | Yes                                   |
| Ordinary Claude chats         | Server-side only; no local catalog                           | No, and never shown as a Code session |
| Cowork / local agent mode     | `local-agent-mode-sessions/` (separate store and routes)     | No                                    |
| Terminal `claude` sessions    | `~/.claude/projects/*.jsonl`, no desktop record or deep link | No                                    |

The desktop store lives in `~/Library/Application Support/Claude/`. The adapter enumerates every record in it without a count limit. The store is a directory, so there is no pagination.

## Why not hooks

Claude Code [hooks](https://code.claude.com/docs/en/hooks) (`Stop`, `Notification`, `UserPromptSubmit`, …) are the documented integration. They were not used, for three reasons:

1. Hooks require editing the user's Claude settings. The handoff does not authorize that change, and Monitor must not change source-app configuration.
2. Hooks report execution, but they do not expose desktop read/acknowledgment state or exact-session navigation. Monitor would still need the desktop records.
3. A hook runs only for turns started after it is installed. It cannot baseline existing tasks.

If hook-based observation is wanted later, it should be an opt-in the user configures. It could replace the process registry below for running/waiting evidence.

## Sources

**Desktop session record** (read-only JSON, polled every 3 s plus `fs.watch`). The adapter keeps only these fields: `sessionId`, `title`, `cwd`, `isArchived`, `createdAt`, `lastActivityAt`, `lastFocusedAt`, `lastAssistantUuid`, and `errorAt`. It uses `errorAt` only when `error` is present, and never reads the error text. Records also carry prompt snapshots, summaries, and error messages. Those are parsed in memory and discarded; none reach `Session`, Monitor's database, or the renderer. Records over 16 MiB and unparseable (mid-write) files are skipped until the next pass.

- The desktop sets `lastAssistantUuid` on every top-level assistant message.
- It sets `lastActivityAt` on every stream event, including turn completion.
- It sets `lastFocusedAt` when the session becomes visible in the app, which includes navigation by deep link.

**Claude Code process registry**: `$CLAUDE_CONFIG_DIR/sessions/<pid>.json` (default `~/.claude/sessions`). Each desktop session runs a CLI process that registers here:

- `status` ∈ `busy | shell | idle | waiting`.
- `waitingFor` is a fixed phrase such as `permission prompt` or `input needed`.
- `statusUpdatedAt` records when the status last changed.
- `hostSessionId` links the process to its desktop `local_<id>`.

Only records whose pid is alive (`kill(pid, 0)`) count. Monitor never connects to the registry's messaging sockets.

**Desktop liveness**: `/bin/ps -Ax -o comm=` must list `…/Claude.app/Contents/MacOS/Claude`.

## State mapping

| Evidence                                        | Monitor state | `attentionKey`               |
| ----------------------------------------------- | ------------- | ---------------------------- |
| Desktop not running                             | Unavailable   | none                         |
| Live process `waiting` (permission prompt)      | Needs review  | `waiting:<statusUpdatedAt>`  |
| Live process `waiting` (other input)            | Needs review  | `waiting:<statusUpdatedAt>`  |
| Live process `busy` or `shell`                  | Running       | none                         |
| Recorded error, not focused since `errorAt`     | Needs review  | `error:<errorAt>`            |
| Recorded error, focused since                   | Read          | `error:<errorAt>`            |
| Last result, not focused since `lastActivityAt` | Needs review  | `result:<lastAssistantUuid>` |
| Last result, focused since                      | Read          | `result:<lastAssistantUuid>` |
| No result recorded yet                          | Unavailable   | none                         |

Result identity is present even when the result is read, so a turn that finishes in the foreground still notifies once. Identity comes from the same file read as the state, so the adapter never emits a live idle state before identity is known.

Disconnect and reconnect:

- When the desktop quits, the adapter emits offline health first, then every session as unavailable.
- On relaunch, the next observation is a fresh baseline. Results that landed while offline do not notify.
- A missing CLI process is never treated as success. The key names the specific recorded assistant message, not "the latest turn succeeded".

## Limitations

- **No authoritative read receipt.** The Code-tab sidebar's blue dot is renderer-only state and is not persisted anywhere Monitor can read safely. `lastFocusedAt` is used as acknowledgment evidence instead:
  - Opening a session after its result marks it read.
  - Watching a session finish while it is already visible does **not**. It stays in Needs review until you switch away and back, or open it from Monitor.
  - Marking a session read or unread in the Claude sidebar is not reflected.
  - Metadata-only activity after focus, such as system notifications injected into the session, can move a read session back to review without a new notification.
- **Running evidence depends on the CLI registry.** A turn whose CLI process crashed shows the last recorded result, not a failure. `interruptedByQuitAt` is not interpreted.
- **Pending approvals come from the CLI registry.** They are visible only while that process is alive; the desktop does not persist its `pendingToolPermissions`.
- The desktop record is saved on a debounce, so state can lag the UI by a moment.
- Only sessions with a local desktop record are listed. Cloud (`cse_…`) sessions are not. Remote/SSH sessions were not exercised.

## Navigation

The desktop registers the `claude:` scheme. Its handler accepts `claude://code/continue?session=<id>` where the id matches `^local_[A-Za-z0-9-]{1,64}$`, and navigates to that session's route. The adapter validates the same pattern. The main process additionally accepts only that exact URL shape for `claude:`. The handler is inert when a managed policy sets `disableDeepLinks` or the app is logged out.

## Verification

Fixture-tested (`tests/claude.test.ts`, `tests/service.test.ts`):

- Whitelisted parsing with no transcript leakage, and source immutability.
- Registry liveness and malformed entries.
- Running → approval → running → result → acknowledgment.
- Error acknowledgment.
- Offline → reconnect baseline.
- Archived tasks followed only when already admitted.
- URL validation.
- Snoozed and archived mixed-provider groups staying quiet.

Observed live on the development Mac (`npm run probe:claude`):

- Discovery and health `live`.
- This Code session reported `running` from its `busy` registry entry.
- Opening `claude://code/continue?session=local_…` focused the exact session in the desktop app. `lastFocusedAt` moved to the moment of the call, and the desktop log recorded warming that session.

`npm run probe:claude -- 300` logs each state transition for five minutes, for manual end-to-end checks.
