# Codex companion integration

The `plugins/monitor-codex` package uses the documented [Codex hooks](https://learn.chatgpt.com/docs/hooks) format. Hooks observe SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, PostCompact, Stop, Interrupt, and SessionEnd. They run synchronously with a three-second timeout, return only `{}`, never decide approvals or request continuation, and write no model context. PermissionRequest is intentionally absent: another handler can approve it immediately, so that event alone cannot prove that the user needs to act.

Codex's documented [notify callback](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications) supplies the separate `agent-turn-complete` event. Stop is a pre-completion hook that can request continuation, so it cannot substitute for this callback. No transcript parsing or model cooperation is involved.

## Installation and removal

`python3 scripts/install-codex.py` copies the plugin into `~/plugins/monitor-codex`, adds it to the personal marketplace at `~/.agents/plugins/marketplace.json`, and installs it with the Codex CLI. It copies the completion bridge into `~/Library/Application Support/Monitor/codex-bridge` and updates only the root `notify` setting. Its prior argument vector is kept in a private `forward.json` and invoked once with the original event; raw event payloads are never saved by Monitor. Other TOML settings and other marketplace entries are preserved. The install is repeatable. `--uninstall` removes the plugin and restores the original callback only if Monitor still owns `notify`, leaving subsequent user changes alone.

After installation, restart Codex and review/trust the hook definitions in Codex. Hook trust is a source-app requirement; Monitor does not edit the trust store or bypass the review. Use current Codex and Python 3.11+. Supported hooks must be enabled by the source environment. Local hooks are not a cloud-observer API.

## Evidence and state

Records live in `~/Library/Application Support/Monitor/codex-hooks`, overridable by `MONITOR_CODEX_HOOKS_DIR` in both the source process and Monitor. Only task ID, turn ID, event name, time, and optional terminal ownership metadata (process ID, start time, controlling TTY, observation time and end flag) are persisted. A bounded per-task lock and atomic replacement handle concurrent callbacks. Files are private to the OS user. The reader rejects symlinks, unsafe permissions, oversized/malformed records, and invalid identities/times. Records from subagents or sessions absent from the main catalog cannot create queue entries.

For terminal ownership, the writer walks its process ancestors using `ps` executable names, never process arguments or environment contents. The first Codex ancestor must have a controlling terminal. Monitor checks its PID, start time, terminal and executable again; if `/new` reuses that process, only the newest task binding can focus it. A failed process lookup does not enable Resume. Process liveness is navigation evidence, not proof that the model is working; the activity freshness limit still applies.

Every Codex task keeps its desktop link. Show in iTerm and Resume in iTerm are secondary actions in details. Resume uses the exact session UUID and shell-quotes its project directory, after refreshing observations and checking that neither its CLI nor a desktop turn is active. It does not terminate a CLI turn or convert history. Desktop and CLI observations update the same Monitor task and preserve its group, priority and archive state.

Current desktop runtime state and read receipts take precedence. A receipt for an older turn cannot acknowledge a newer turn observed by the companion. When current desktop state is unavailable:

| Companion evidence                                             | Monitor state                                   |
| -------------------------------------------------------------- | ----------------------------------------------- |
| Activity within the last two minutes                           | Running, labeled as recent plugin activity      |
| Confirmed completion for the current turn                      | Needs review, explicitly missing a read receipt |
| Interrupt                                                      | Needs review, labeled interrupted               |
| Stop alone, ended session without completion, expired activity | Status unavailable                              |

The two-minute limit is a freshness limit, not a completion timer: a long model response with no tool activity can become unavailable until the next event. SessionStart after resume clears prior completion evidence; compaction preserves the active turn. A late completion for a different turn is discarded. Desktop and companion result identities both use `result:<turn-id>` so the two sources do not produce duplicate notifications. History loaded at startup is quiet but establishes the baseline for future completions.

The [desktop observer](codex-integration.md) remains because hooks do not expose source read receipts, complete runtime snapshots, or existing-task discovery. It is not support for older Codex versions. A confirmed result without a desktop receipt is conservatively offered for review; Monitor never invents a read acknowledgment.

## Verification boundaries

Tests execute the actual Python hook/notification writer with synthetic payloads and temporary files. They cover privacy, provisional stops, continued turns, late callbacks, interruptions, expiring activity, malformed records, and forwarding an existing notifier. Adapter tests verify desktop precedence, observation without IPC, terminal ownership, exited/reused PIDs and `/new`. Service tests verify quiet history, deduplication across sources and resume revalidation. The Electron smoke test exercises desktop-first CLI navigation plus Show/Resume in iTerm through production IPC, with OS process/AppleScript calls stubbed. Installer tests use a fake CLI and isolated home to check repeatability, unrelated TOML preservation, and restoring a previous callback.

These tests do not prove event delivery by a particular Codex installation before its hooks are trusted and a new task is run. A CLI plugin installation and manifest validation also do not prove live hook delivery or native notification display under macOS Focus settings.

On the development Mac, the desktop's bundled Codex CLI `0.153.4` installed the companion successfully. Its read-only `hooks/list` endpoint discovered all nine Monitor hooks as enabled and awaiting trust. No agent turn was started and no hook trust was granted during that verification.
