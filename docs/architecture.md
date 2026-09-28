# Architecture proposal

Status: proposed stack; no application code or integration spike yet.

## Recommendation

Use **Electron, React, TypeScript, Vite, and SQLite** for the first implementation.

The work includes a frequently revised queue UI, local session observers, native desktop notifications, and navigation into other apps. Electron provides a Node.js main process alongside a web renderer, allowing UI and adapter code to share TypeScript contracts. React is a practical fit for the grouping and editing interactions already being explored.

Electron's Chromium runtime has an application-size and resource cost. For this first version, keeping the UI and local integration work in one language is the stronger tradeoff. Revisit actual idle CPU, memory, and wakeups after the observer spike rather than predicting specific footprint numbers.

Tauri is a credible alternative: it uses WKWebView on macOS and a Rust core. Choose it if a smaller runtime footprint becomes a leading requirement and maintaining Rust alongside TypeScript is acceptable. SwiftUI is another option if Mac-native behavior becomes more important than web UI iteration and portability.

## Process boundaries

```text
Claude adapter ─┐
               ├─ normalized events → local state + SQLite → React queue
Codex adapter ─┘                          │
                                        ├─ notification policy → macOS
                                        └─ session opener → source desktop app
```

### Electron main process

Own application lifecycle, notification delivery, session navigation, database access, and observer coordination. Keep the process alive while the window is closed if monitoring is enabled. Explicit application quit stops monitoring in the initial design; monitoring after quit would require a separate background service and is a later decision.

Move adapter work to a utility process if its workload or failure isolation warrants it. Never block UI responsiveness with log parsing or database scans.

### Renderer and preload

Use React and TypeScript for the queue, group editor, snooze controls, and task details. Vite supports UI development and bundling; select the Electron packaging tooling when scaffolding the application.

Expose a narrow typed interface through a context-isolated preload bridge. The renderer requests product operations such as rename, reorder, snooze, or open-session; privileged filesystem and process operations stay outside it. Validate external navigation destinations in the main process.

### Local storage

Use SQLite for group names, ordered membership, stable priority, project overrides, snoozes, session references, ingestion checkpoints, and notification deduplication. Store runtime data in the app's user-data directory, outside this source repository. Select the SQLite binding after choosing the Electron runtime version.

Minimum conceptual entities:

- `Session`: provider, stable session id, title, source directory, observed execution state, latest result identity, observation timestamp, adapter health, and navigation reference.
- `Group`: id, manual name, priority position, optional project override, and optional snooze deadline or manual snooze flag.
- `Membership`: group id and session id.
- `AttentionReceipt`: session/result identity and acknowledgment evidence, when available.
- `IngestionCheckpoint`: source identity and last processed event or offset.
- `NotificationReceipt`: stable event identity and delivery state.

Derive the active queue section from member states. Store snooze independently; it changes group placement and notification policy without rewriting session states. Store priority independently from both.

## Session adapters

Implement Codex and Claude as separate adapters behind a common observation and navigation interface. They observe existing sessions and do not start replacement harnesses.

Prefer supported lifecycle hooks or APIs. Reconcile state on startup and reconnect so hook delivery is not the only source of truth. Keep hooks short and advisory; local observer failures must not delay or steer the agents.

If local transcripts or state files are required, isolate that logic in a version-aware read-only adapter. Treat file formats as integration dependencies, not durable public contracts. Do not mutate the harnesses' databases or infer completion from a quiet transcript.

Keep source sequence information where available. Handle duplicate events, delayed events, resumed sessions, interrupted turns, and application restarts. A Stop signal may precede a hook-driven continuation; do not assume every such signal is a final result without validating the harness semantics.

Ordinary Claude chat monitoring is a separate capability from Claude Code hooks. Detect unsupported session types explicitly.

## First spike and acceptance evidence

For each installed desktop app, demonstrate:

1. Stable identity for an existing session.
2. Observation of prompt submission, active execution, final response, interruption, and requests for input or permission where supported.
3. One native notification per new actionable transition, with duplicates suppressed after restart.
4. Opening the exact originating session from a notification or session entry.
5. A group snooze that leaves session execution unchanged and returns the group using current state and saved priority.

Live evidence for these paths is the milestone. A UI mockup, sample event fixture, or passing unit test alone does not validate desktop integration.

## Validation plan once code exists

Use focused tests for derived section precedence, stable relative ordering, response acknowledgment identity, snooze expiry, event deduplication, and recovery from missed events. Keep observer tests separate from UI tests. Verify native notifications and exact-session opening manually on the target Mac, including packaged-app behavior.

## Sources

- [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)
- [Electron notifications](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security)
- [Tauri process model](https://v2.tauri.app/concept/process-model/)

Provider-specific hooks and deep links were investigated during product planning, but installed-app compatibility remains unverified. Recheck the official provider documentation when implementing each adapter.
