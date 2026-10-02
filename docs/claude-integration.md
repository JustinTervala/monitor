# Claude observer

Compatibility was inspected on macOS with Claude desktop `2.16120.0` (bundle `com.anthropic.claudefordesktop`) and its bundled Claude Code CLI `2.1.284`. Like the Codex adapter, this is a read-only observer of **undocumented local stores**, not a supported public API.

## What is observable

| Claude surface                          | Local state                                                              | Represented                           |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| Desktop **Code** tab sessions           | `claude-code-sessions/<account>/<org>/local_<id>.json`                   | Yes; opens in Claude                  |
| Terminal `claude` sessions (e.g. iTerm) | Process registry while running; `monitor-hooks` plugin files for results | Yes; copy a resume command            |
| Ordinary Claude chats                   | Server-side only; no local catalog                                       | No, and never shown as a Code session |
| Cowork / local agent mode               | `local-agent-mode-sessions/` (separate store and routes)                 | No                                    |
| Headless `claude -p` runs               | Registry entry with a non-`cli` entrypoint                               | No                                    |
| Sessions on other machines              | That machine's `~/.claude`                                               | No                                    |

The desktop store lives in `~/Library/Application Support/Claude/`. The adapter enumerates every record in it without a count limit. The store is a directory, so there is no pagination.

## Fork ancestry

Desktop records expose `forkedFromSessionId`; `lineageDetached` clears the displayed parent relationship. Agent-spawn and suggested-task links are not treated as user forks. For CLI forks and desktop sessions resumed from CLI, the adapter reads up to 1 MiB of the session-file prefix under the configured `projects/<encoded-cwd>/<session-id>.jsonl`. It reduces the first matching user/assistant record to `forkedFrom.sessionId`, validates the current/parent IDs, and discards message content. Parent CLI IDs map to a known desktop session when available, so a family can cross surfaces without creating duplicate tasks. This observes already-discovered sessions; it does not import all historical CLI transcripts.

The cache keeps only parent IDs and file identity/size. Missing files, oversized prefixes, or invalid metadata leave CLI ancestry unavailable. Fork-point message bodies and identifiers are not persisted or shown. Desktop field semantics and CLI serialization were inspected in the installed source-app bundles; automated tests use synthetic fixtures, including cross-surface ancestry and detachment. No live Claude fork was created during validation. Restart Monitor after installing the updated build; no hook reinstall or source-app restart is needed for ancestry.

## Hooks plugin (terminal sessions)

Terminal sessions have no persisted state that Monitor can read, apart from the live process registry. The optional **`monitor-hooks`** plugin (`plugins/monitor-hooks/`) fills that gap with documented Claude Code [hooks](https://code.claude.com/docs/en/hooks). Installing it is the user's choice; Monitor never edits Claude settings itself.

```sh
claude plugin marketplace add /path/to/monitor
claude plugin install monitor-hooks@monitor
```

- **Events:** `SessionStart`, `Stop`, `StopFailure` and `SessionEnd`. All are exec-form (`/bin/sh` plus the script path) and `async`, so they never delay Claude. Subagent events are ignored.
- **Parsing:** the script parses the hook JSON with the macOS built-in `/usr/bin/plutil`, so there are no dependencies. Where `plutil` is missing (e.g. Linux), it exits silently.
- **What it writes:** one small `key=value` file per event kind, `<session>.{start,result,end}`, in `~/Library/Application Support/Monitor/claude-hooks/` (`MONITOR_CLAUDE_HOOKS_DIR` overrides it). The fields are session id, time, `CLAUDE_CODE_ENTRYPOINT`, cwd, session title, `prompt_id`, error type and end reason. Each file is written atomically, mode `0600`.
- **What it never writes:** hook input includes `prompt_text` or `last_assistant_message`. That text stays in the hook's memory and is never written; a test asserts this.
- **Entrypoint filter:** hooks also fire in desktop sessions. Monitor only admits hook sessions whose entrypoint is `cli`, and never lists a desktop session twice.

Without the plugin, terminal sessions still appear while their process runs, as running, waiting or "install monitor-hooks to see results". They just can't produce result notifications.

## Sources

**Desktop session record** (read-only JSON, polled every 3 s plus `fs.watch`). The adapter keeps only these fields: `sessionId`, `title`, `cwd`, `isArchived`, `createdAt`, `lastActivityAt`, `lastFocusedAt`, `lastAssistantUuid`, `completedTurns`, and `errorAt`. It uses `errorAt` only when `error` is present, and never reads the error text. Records also carry prompt snapshots, summaries, and error messages. Those are parsed in memory and discarded; none reach `Session`, Monitor's database, or the renderer. Records over 16 MiB and unparseable (mid-write) files are skipped until the next pass.

- The desktop sets `lastAssistantUuid` on every top-level assistant message. It was observed live changing twice within 3 s of one turn ending (an intermediate save, then the final message), so it is not used as result identity.
- `completedTurns` increments once per successful turn and is the result identity. A turn that ends in an error is identified by `errorAt` instead; a turn you interrupt produces no new result.
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

| Evidence                                        | Monitor state | `attentionKey`              |
| ----------------------------------------------- | ------------- | --------------------------- |
| Desktop not running                             | Unavailable   | none                        |
| Live process `waiting` (permission prompt)      | Needs review  | `waiting:<statusUpdatedAt>` |
| Live process `waiting` (other input)            | Needs review  | `waiting:<statusUpdatedAt>` |
| Live process `busy` or `shell`                  | Running       | none                        |
| Recorded error, not focused since `errorAt`     | Needs review  | `error:<errorAt>`           |
| Recorded error, focused since                   | Read          | `error:<errorAt>`           |
| Last result, not focused since `lastActivityAt` | Needs review  | `result:<completedTurns>`   |
| Last result, focused since                      | Read          | `result:<completedTurns>`   |
| No result recorded yet                          | Unavailable   | none                        |

Result identity is present even when the result is read, so a turn that finishes in the foreground still notifies once. Identity comes from the same file read as the state, so the adapter never emits a live idle state before identity is known.

Disconnect and reconnect:

- When the desktop quits, the adapter emits offline health first, then every session as unavailable.
- On relaunch, the next observation is a fresh baseline. Results that landed while offline do not notify.
- A missing CLI process is never treated as success. The key names the specific recorded assistant message, not "the latest turn succeeded".

### Terminal sessions

| Evidence                                              | Monitor state | `attentionKey`              |
| ----------------------------------------------------- | ------------- | --------------------------- |
| Live CLI process `waiting`                            | Needs review  | `waiting:<statusUpdatedAt>` |
| Live CLI process `busy` or `shell`                    | Running       | none                        |
| `Stop` hook result, process idle or exited            | Needs review  | `result:<prompt_id>`        |
| `StopFailure` hook result                             | Needs review  | `error:<prompt_id>`         |
| `SessionEnd` recorded after the result (e.g. `/exit`) | Read          | unchanged                   |
| No live process and no recorded result                | Unavailable   | none                        |

A terminal has no read receipt or focus signal. A result stays in Needs review until the session ends, or until the next prompt makes it run again. Once the process has exited, the evidence is `history`, so a result first seen after exit does not notify.

## Limitations

- **No authoritative read receipt.** The Code-tab sidebar's blue dot is renderer-only state and is not persisted anywhere Monitor can read safely. `lastFocusedAt` is used as acknowledgment evidence instead:
  - Opening a session after its result marks it read.
  - Watching a session finish while it is already visible does **not**. It stays in Needs review until you switch to another session and back. Opening it from Monitor while it is already on screen does not count either; this was observed live.
  - Marking a session read or unread in the Claude sidebar is not reflected.
  - Metadata-only activity after focus, such as system notifications injected into the session, can move a read session back to review without a new notification.
- **Running evidence depends on the CLI registry.** A turn whose CLI process crashed shows the last recorded result, not a failure. `interruptedByQuitAt` is not interpreted.
- **Pending approvals come from the CLI registry.** They are visible only while that process is alive; the desktop does not persist its `pendingToolPermissions`.
- The desktop record is saved on a debounce, so state can lag the UI by a moment.
- Only sessions with a local desktop record are listed. Cloud (`cse_…`) sessions are not. Remote/SSH sessions were not exercised.

## Navigation

The desktop registers the `claude:` scheme. Its handler accepts `claude://code/continue?session=<id>` where the id matches `^local_[A-Za-z0-9-]{1,64}$`, and navigates to that session's route. The adapter validates the same pattern. The main process additionally accepts only that exact URL shape for `claude:`. The handler is inert when a managed policy sets `disableDeepLinks` or the app is logged out.

## iTerm2 and resuming

iTerm2 has no URL scheme for tabs or commands. Monitor drives it with iTerm2's AppleScript dictionary (`application id "com.googlecode.iterm2"`) via `/usr/bin/osascript`. Every value reaches the script through `argv`; nothing is interpolated into script source.

| Task                             | Primary action      | How                                                                                                                                  |
| -------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Terminal session, process alive  | **Show in iTerm**   | Registry pid → `ps -o tty=,comm=` (must still be a `claude` process) → select the iTerm2 session whose `tty` matches, bring it front |
| Terminal session, process exited | **Resume in iTerm** | New tab in the current window (or a new window) → `write text` the resume command                                                    |
| Desktop session                  | Open in Claude      | Deep link; **Show in iTerm** is also offered while it's resumed in a terminal                                                        |

**Copy resume command** is on every Claude task with a Claude Code session id: `cd '<session directory>' && claude --resume <session-id>`. The main process builds it from observed state, never from renderer text. The directory is single-quoted for POSIX shells and the id must be a UUID.

Notification clicks use the same primary action. A terminal session that has exited shows Monitor instead of resuming automatically.

Caveats:

- **Permission:** the first use asks for Automation permission ("Monitor wants to control iTerm2"). The packaged app declares `NSAppleEventsUsageDescription` for this; stock Electron in `npm run dev` does not, so macOS may refuse there. If it's denied, Monitor explains how to allow it in System Settings → Privacy & Security → Automation.
- **tmux:** a session inside tmux has tmux's tty, not an iTerm tab's, so Show reports that no tab owns it. Use Copy resume command.
- **Desktop sessions:** Resume in iTerm is deliberately not offered, so a desktop session is never run twice.
- **Same machine only:** transcripts live in this Mac's `~/.claude/projects`.

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
- iTerm2: tty lookup, pid-reuse guard, argv-only AppleScript, missing tab and denied permission (`tests/iterm.test.ts`, fake process runner). Both scripts compile against the installed iTerm2 3.4.4 dictionary (`osacompile`). The Electron UI shows Show/Resume/Copy for live and exited terminal sessions.

Observed live on the development Mac (`npm run probe:claude`):

- Discovery and health `live`.
- This Code session reported `running` from its `busy` registry entry, then `review` with a result identity within a second of its turn ending (desktop log: query completed 06:28:30).
- Opening `claude://code/continue?session=local_…` focused the exact session in the desktop app. `lastFocusedAt` moved to the moment of the call, and the desktop log recorded warming that session.

`npm run probe:claude -- 300` logs each state transition for five minutes, for manual end-to-end checks.
