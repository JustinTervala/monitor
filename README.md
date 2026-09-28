# Monitor

A local Mac control plane for ongoing Claude and Codex work. Keep using the existing desktop apps; Monitor shows what needs attention, preserves workstream priority, and opens the relevant session.

## Status

Product design and architecture proposal. The application and session integrations have not been implemented yet.

## Product model

- One named task group occupies one queue row, even when its tasks have different states.
- The group's section follows its highest-attention task: **Needs review → Running → Read**.
- Groups have a persistent relative priority that survives section changes.
- Individual task states come from their sessions and are displayed read-only.
- Snoozing applies to the whole group. Sessions keep working; the group defers notifications and returns at its saved priority when the snooze ends.
- A project tag is inferred from the shared source directory when all tasks agree, with a manual override available.

See [the product specification](docs/product-spec.md) for the agreed behavior and remaining design questions.

## Proposed stack

**Electron + React + TypeScript + SQLite**, with Vite for UI development.

- **Electron main process:** app lifecycle, native notifications, opening session links, local persistence, and observer coordination.
- **React renderer:** grouped queue, drag and drop, editing, and session details.
- **TypeScript adapters:** separate Codex and Claude integrations feeding normalized session events into a shared model.
- **SQLite:** durable grouping, relative order, snoozes, session references, and event checkpoints.

See [the architecture proposal](docs/architecture.md) for tradeoffs and integration boundaries. This is a recommendation, not a claim that a runtime is already scaffolded.

## First implementation milestone

Prove the full loop on one existing session in each desktop app:

1. Identify the session and observe its state without taking ownership of execution.
2. Detect completion or a request for attention.
3. Deliver one native notification for that transition.
4. Open the exact originating session on click.
5. Reconcile state after a restart without duplicate notifications.

Then build the queue UI against those adapters. Completion detection and exact-session navigation remain unverified until tested against the installed apps.
