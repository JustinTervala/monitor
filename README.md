# Monitor

A local Mac control plane for ongoing AI work. Keep using Codex and Claude; Monitor watches your existing sessions, preserves workstream priority, and opens the originating task.

It observes **Codex desktop** tasks, **Claude desktop Code-tab** sessions and, with the companion plugins, **Codex CLI** and **terminal Claude** sessions. Ordinary Claude chats are not represented.

## Run

Requires macOS and local Codex or Claude tasks. Building from source requires Node 24+. No API key or extra agent harness.

Download the Mac app from [GitHub Releases](https://github.com/JustinTervala/monitor/releases). The public repository and downloads do not require a GitHub login. Monitor uses the source apps already configured on that Mac; no Monitor account is needed.

To build from source:

```sh
git clone https://github.com/JustinTervala/monitor.git
cd monitor
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

### Terminal Claude sessions (optional)

To get turn results from `claude` sessions in iTerm or another terminal, install the bundled hooks plugin once:

```sh
claude plugin marketplace add /path/to/this/repo
claude plugin install monitor-hooks@monitor
```

It records session ids, timings and directories only, never prompts or responses. Terminal tasks offer **Show in iTerm** (jumps to the tab running the session) or, after it exits, **Resume in iTerm** (new tab running `claude --resume`). **Copy resume command** works for any Claude task. The first use asks macOS for permission to control iTerm2.

### Codex companion integration

Use the current Codex desktop app and CLI, plus Python 3.11 or newer. From this repository, run:

```sh
python3 scripts/install-codex.py
```

If the CLI on your PATH is older than the one in your desktop app, pass its path explicitly, for example `python3 scripts/install-codex.py --codex /Applications/ChatGPT.app/Contents/Resources/codex`.

The installer adds **monitor-codex** to your personal plugin marketplace, installs it, and connects Codex's completion callback. Any existing callback is preserved and forwarded to once. Restart Codex, then review and trust the Monitor hooks in `/hooks` in the CLI (or the desktop hook review UI). Start or resume a task after trusting them. The installer never grants hook trust. No account or API key is needed for Monitor.

Hooks report recent activity and interruptions; the separate completion callback confirms finished turns. Desktop state supplies approvals and read receipts. If desktop state is unavailable, a confirmed result appears in **Needs review** with **read receipt unavailable**; opening the task lets the desktop provide its actual receipt. A `Stop` hook alone never counts as completion. Activity without a fresh event expires after two minutes instead of appearing to run forever.

**Codex CLI tasks appear automatically and keep Open Codex as their main action**, opening the same saved task in desktop. The details pane also offers **Show in iTerm** for a live CLI session, or **Resume in iTerm** after it exits (`codex resume <session-id>` in its project directory). No conversation conversion or duplicate Monitor task is created. The companion records the owning process ID, start time and terminal; Monitor checks these before focusing a tab, including when `/new` reuses a CLI process. Opening desktop does not automatically stop or transfer an in-flight CLI turn. Finish or interrupt that turn before continuing elsewhere. Resume is unavailable while a live CLI or active desktop turn is observed; it starts only when you click it.

After updating this checkout, rerun the installer and restart Codex. Remove the integration with `python3 scripts/install-codex.py --uninstall`; it restores your previous completion callback if Monitor still owns that setting. Your workstreams and recorded metadata stay intact. See [companion integration](docs/codex-companion.md) for details and verification limits.

## Use

- All non-archived tasks in the local Codex catalog and Claude Code tab appear automatically, including tasks created while Monitor is running. There is no import step or task-count limit. Codex discovery refreshes every second; Claude every three seconds.
- Use **Open Codex** / **Open Claude** directly on a queue row to open the task in one click. For a group, the shortcut picks a task needing review first, then running, unavailable, and read; the most recent task wins ties. Hover to see the exact task. Terminal Claude tasks offer **Show in iTerm** or **Resume in iTerm**. Select the row itself to inspect or manage all its tasks.
- Drag a row onto another row and name the combined workstream. One group occupies one row.
- Drag the **⠿ handle** to reorder. The **Priority** view shows the global order across sections; arrow buttons in details provide keyboard-accessible ordering.
- **Edit group** changes its name or project tag. **Detach** splits out a member. Use group snoozing to put a workstream aside.
- Existing groups, names, snoozes, and priority survive discovery and upgrades. Newly discovered tasks start as single-task rows at the end of your saved priority order.
- Snooze the whole workstream for an hour, until tomorrow at 9 AM local time, or until restored. Members keep executing and notifications pause.
- **Archive workstream** moves the whole group to the separate **Archived** page. Browse collapsible projects with workstreams sorted by their latest task activity, or search by name, task, or directory. Archiving is local to Monitor; Codex stays unchanged.
- Archived groups keep their names, membership, and saved priority. Notifications pause and new activity stays archived. **Restore to queue** returns the group at its saved priority using current task states, without replaying past notifications. Archiving clears any previous snooze.

Section precedence is **Needs review → Running → Status unavailable → Read**; Snoozed overrides placement. Relative priority remains stable across all these states. There is no task-status editor. The source apps own execution state and read receipts. Claude has no readable read receipt, so a Claude result counts as read once you open that session in Claude after it finishes (see [Claude integration](docs/claude-integration.md)).

## Notifications

Newly observed completions, input requests, approvals, and errors can produce native macOS notifications. Clicking opens the originating task. Notifications are on by default and can be toggled in the toolbar; macOS permission and Focus settings still apply.

Use **Monitor → Test notification** to check native delivery on your Mac.

Use the packaged app for native notification testing: Electron requires a valid app signature on current macOS notification APIs. `npm run dev` is for UI development. See [Electron's notification requirements](https://www.electronjs.org/docs/latest/tutorial/notifications#macos).

Initial snapshots and reconnection backlogs are quiet. Result/request identities are persisted to suppress duplicates. Snooze expiry does not replay notifications for work that finished while snoozed. A task that finishes while already read in Codex may notify but remains in Read.

## Integration limits

This release observes **local Codex tasks**, not cloud/remote tasks. It reads catalog metadata from Codex's SQLite database and subscribes as a non-owning follower to the desktop's local IPC stream. CLI activity remains observable with desktop closed when the companion is installed and trusted. Monitor never automatically resumes tasks, sends prompts, or answers approvals. Only the explicit companion installer changes Codex settings. The iTerm shortcut targets local controlling terminals; it cannot select a pane inside tmux or a session on another machine.

For Claude, Monitor reads the desktop's Code-session records and the Claude Code process registry (`~/.claude/sessions`). It does not install hooks or change Claude settings. See [Claude integration](docs/claude-integration.md) for the state mapping and limits.

The desktop observer protocol is **internal**, tested against desktop `26.903.61454`, stream version `11`. It may change with app updates. Supported companion observations fill gaps; otherwise unsupported or disconnected state becomes **Status unavailable**, never an invented completion. A catalog entry alone is insufficient to know whether a task is running; open it in Codex if no desktop window currently supplies live state.

Codex's socket sends conversation snapshots. The adapter immediately reduces them to metadata, runtime state, and result/request identities. Prompts, responses, and tool payloads are not persisted or sent to the renderer. Monitor's own state lives in its Electron user-data directory in `monitor.sqlite`.

## Development

Monitor is a personal app targeting current dependencies and source apps. Upgrades may require reinstalling integrations or updating tools; old versions and configuration formats are not compatibility targets. Personal workstream data is preserved.

Stack: **Electron + React + TypeScript + Vite + SQLite** (`node:sqlite`).

```sh
npm run check        # TypeScript, behavioral tests, production build
npm run smoke        # Actual Electron UI, isolated fake Codex socket/database
npm run probe:codex  # Read-only live probe of all discovered local tasks
npm run probe:codex -- TASK_ID
npm run probe:claude        # Read-only live probe of Claude desktop Code sessions
npm run probe:claude -- 300 # ...and log state transitions for five minutes
```

The smoke test creates temporary source and Monitor databases; it does not edit your real queue. Screenshots are saved to `.runtime/smoke.png` and `.runtime/archive-smoke.png`.

The app icon is [Watchkeeper, the monitor lizard](assets/icon-concepts/lizards/watchkeeper-v1.png). Development builds use the same artwork in the Dock. Packaging generates the full macOS icon set with the built-in `sips` and `iconutil` tools; no separate asset-generation step is needed. The original image-generation prompts are saved with the [icon concepts](assets/icon-concepts/lizards/prompts.json).

See [architecture](docs/architecture.md), [product behavior](docs/product-spec.md), [Codex integration](docs/codex-integration.md), and [Claude integration](docs/claude-integration.md).

## License

Monitor is licensed under the [MIT license](LICENSE). Copyright and license notices for its runtime dependencies are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Every packaged app includes those notices, Monitor’s and Electron’s license texts, and Electron’s complete `LICENSES.chromium.html` in `Monitor.app/Contents/Resources/licenses/`. In Finder, choose **Show Package Contents** on Monitor.app to browse them.

After changing dependencies, run `npm run licenses` and commit the updated notices. `npm run check` and packaging reject stale notices or missing license text. The upstream Chromium notice file is copied unchanged from the matching Electron installation at packaging time.
