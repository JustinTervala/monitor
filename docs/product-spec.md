# Product specification

Status: implemented for local Codex desktop sessions; Claude integration remains a separate adapter task.

## Workflow

The user runs roughly 10–20 concurrent conversations across Claude and Codex. A workstream may move through brainstorming, a handoff document, implementation, a draft PR, repeated reviews and fixes, automated review, and team review. Stacked PRs add dependencies and usually progress from bottom to top.

Monitor helps the user schedule attention while preserving the existing harnesses and conversations. The initial product observes sessions, organizes work, notifies, and navigates back to the source app. Automatic prompting and cross-agent handoffs are outside the first milestone.

## Groups and the queue

All non-archived tasks discovered from the source apps appear automatically, both on startup and as new tasks are created. No manual import or Add Task control is needed. Existing memberships, group names, snoozes, and priority remain unchanged; newly discovered tasks append to the global order. Previously unimported tasks from older Monitor versions are included on the next discovery pass. Existing group members remain organized even if later archived in the source app.

Every admitted task belongs to one workstream, either in the queue or archive. A standalone task appears as a single-task entry. Dragging one task onto another starts group creation and asks for a manually created name. A named group can contain sessions from both harnesses.

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
3. **Status unavailable:** a member lacks current source evidence and no member is running or needs attention.
4. **Read:** all members have source read receipts and no session is running or needs attention.

Example: a group containing a review task, a running task, and a read task appears only in Needs review. After the review item is acknowledged, the group moves to Running. The group's identity and saved priority are unchanged.

Task states are read-only in Monitor. There is no per-task status dropdown. Runtime state comes from the harness. Read/acknowledgment is separate from execution state; Codex supplies the authoritative read receipt. Opening and reading the task in Codex updates Monitor.

Waiting for approval, waiting for input, errors, and disconnected observers must remain distinguishable in the task details. An observer losing contact is not evidence of task completion. Unknown state has its own section between Running and Read.

## Relative priority

Maintain one persistent total order of queue entries, independent of current section. Each section displays its entries in that saved order.

- Reordering changes group priority, not session state.
- A section change never changes saved relative priority.
- Grouping and renaming do not create extra queue entries.
- Creation default: a newly created group inherits the higher priority of its two original entries.
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

The concept supports one hour, tomorrow morning, or until explicitly unsnoozed. Merging retains the drop target’s snooze policy, made explicit in the naming dialog. Detaching a queue member creates an active singleton immediately after the original group.

## Archive

**Archived** is a separate page, organized by collapsible project sections. Archive a whole workstream using its row action or detail pane. This is a Monitor-only decision: source tasks remain unchanged, including their execution state and source archive flags. Existing queues remain active on upgrade; unavailable or old tasks are never automatically archived.

- Archived workstreams keep one row, their names, membership, project overrides, and saved global priority. They are excluded from queue sections and attention counts.
- Use full normalized source paths for project identity, displaying the leaf name and full path. Different paths with the same leaf stay separate. Manual project overrides group by their exact label; mixed and unknown projects have their own sections.
- Within each project, sort by the latest member task's source `updatedAt`, newest first. Project sections also sort by their newest activity. Observation time and archive time do not change this ordering.
- Search matches workstream names, task titles, project tags, and source directories. Matching sections expand while searching.
- Observation continues, but Monitor notifications are muted. New results do not return a workstream to the queue or create duplicate entries.
- Archiving clears any snooze. Restoring returns the group to its saved priority and current state, without replaying old notifications. Queue priority controls skip archived entries.
- Names, projects, task links, and detaching remain available in the archive. A detached member stays archived. Restore before merging, reordering, or snoozing.

Monitor's archive is independent of the source catalog's archive filter. Previously untracked source-archived tasks are not imported by this page. A previously admitted task remains in its existing Monitor workstream if later archived in the source app.

## Notifications and navigation

Notify when a tracked session finishes a turn or requires attention, with event deduplication. Finishing a turn does not mean its broader workstream or PR is complete. Group names should provide context in the notification.

Notification clicks and individual session entries should open the exact originating conversation in its desktop app. Group selection reveals member sessions; it should not silently pick an arbitrary member to launch.

Snoozing controls Monitor's notifications. Managing duplicate notifications from the source apps is a separate setup concern; do not alter those settings automatically.

## Editing and later work

- Implemented: rename groups and override or clear project tags.
- Implemented: merge groups and detach members. Use group snoozing to defer work; there is no manual tracking or removal toggle.
- Implemented: archive whole workstreams locally, browse by project and recency, and restore without deleting or archiving source sessions.
- Improve keyboard access, drag affordances, and detail-pane layout.
- Attach handoff documents and PR references.
- Track PR-stack dependencies separately from attention priority.

## Integration questions

- Which Claude sessions are Code tasks, ordinary chats, or a mix?
- What stable observer and exact-session navigation mechanisms exist for the installed app versions?
- Can the source apps provide reliable read receipts?
- How should unknown/disconnected state be surfaced without claiming a task is running or complete?
- What does notification batching look like when several tasks in a group finish close together?
