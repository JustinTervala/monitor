# Product specification

Status: agreed interaction model with open implementation questions.

## Workflow

The user runs roughly 10–20 concurrent conversations across Claude and Codex. A workstream may move through brainstorming, a handoff document, implementation, a draft PR, repeated reviews and fixes, automated review, and team review. Stacked PRs add dependencies and usually progress from bottom to top.

Monitor helps the user schedule attention while preserving the existing harnesses and conversations. The initial product observes sessions, organizes work, notifies, and navigates back to the source app. Automatic prompting and cross-agent handoffs are outside the first milestone.

## Groups and the queue

Every task belongs to one queue entry. A standalone task appears as a single-task entry. Dragging one task onto another starts group creation and asks for a manually created name. A named group can contain sessions from both harnesses.

Each group appears exactly once in the queue, as a single row. Selecting the row reveals its individual sessions and their observed states in a detail view. Group membership never causes tasks to be duplicated across queue sections.

A row shows:

- Group name, or the session title for an ungrouped task.
- Project tag.
- Compact counts of member states, such as “1 review · 2 running”.
- Group snooze information when applicable.

The group name and project tag are independent: “Billing rollout” may belong to project “payments”.

## Section placement

For a group that is not snoozed, the highest section represented by any member determines the group's section:

1. **Needs review:** a session has a new result or otherwise needs the user's attention.
2. **Running:** at least one session is working and no session currently needs attention.
3. **Read:** all results have been acknowledged and no session is running or needs attention.

Example: a group containing a review task, a running task, and a read task appears only in Needs review. After the review item is acknowledged, the group moves to Running. The group's identity and saved priority are unchanged.

Task states are read-only in Monitor. There is no per-task status dropdown. Runtime state comes from the harness. Read/acknowledgment is separate from execution state; its source and exact interaction need validation during integration work.

Waiting for approval, waiting for input, errors, and disconnected observers must remain distinguishable in the task details. An observer losing contact is not evidence of task completion. The treatment of unknown state in the main queue remains a design question.

## Relative priority

Maintain one persistent total order of queue entries, independent of current section. Each section displays its entries in that saved order.

- Reordering changes group priority, not session state.
- A section change never changes saved relative priority.
- Grouping and renaming do not create extra queue entries.
- Proposed creation default: a newly created group inherits the higher priority of its two original entries.
- Use distinct drag targets for grouping and reordering: row body for grouping, a handle and insertion indicator for ordering.

Priority must survive application restarts. The displayed rank can have gaps within a section because it refers to the global ordering.

## Project tags

If every member has the same source directory, infer the project tag from that directory's leaf name. Compare full normalized directory paths before deciding they agree; matching leaf names alone is insufficient.

- Shared `/work/payments` → `payments`.
- Different directories → “Multiple projects”, unless manually overridden.
- Missing directory information → “Project unknown”, unless manually overridden.
- Keep the original full paths available in details.
- Manual overrides remain stable when membership changes.

Whether different Git worktrees should resolve to a common repository identity is deliberately left open. Do not silently treat different directories as the same project.

## Group snoozing

Snooze is a scheduling decision attached to the whole group, independent of its members' execution states. Individual tasks cannot be snoozed.

While a group is snoozed:

- The entire row lives in Snoozed.
- The harnesses continue executing normally.
- State observation and unread-result tracking continue.
- Monitor's notifications for the group are muted.
- A new result does not automatically break the snooze.
- Saved relative priority remains unchanged.

On expiry or explicit unsnooze, derive the group's section from its current task states and reinsert it using saved priority. Never restore a stale pre-snooze section.

The concept supports one hour, tomorrow morning, or until explicitly unsnoozed. Final time presets can change. Behavior when combining snoozed and active entries needs an explicit design decision.

## Notifications and navigation

Notify when a tracked session finishes a turn or requires attention, with event deduplication. Finishing a turn does not mean its broader workstream or PR is complete. Group names should provide context in the notification.

Notification clicks and individual session entries should open the exact originating conversation in its desktop app. Group selection reveals member sessions; it should not silently pick an arbitrary member to launch.

Snoozing controls Monitor's notifications. Managing duplicate notifications from the source apps is a separate setup concern; do not alter those settings automatically.

## Later editing work

- Rename groups and override or clear project tags.
- Add/remove members, split groups, and define group merging behavior.
- Archive completed workstreams without deleting their source sessions.
- Improve keyboard access, drag affordances, and detail-pane layout.
- Attach handoff documents and PR references.
- Track PR-stack dependencies separately from attention priority.

## Integration questions

- Which Claude sessions are Code tasks, ordinary chats, or a mix?
- What stable observer and exact-session navigation mechanisms exist for the installed app versions?
- Can the source apps provide reliable read receipts?
- How should unknown/disconnected state be surfaced without claiming a task is running or complete?
- What does notification batching look like when several tasks in a group finish close together?
