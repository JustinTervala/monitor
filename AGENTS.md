# Monitor project guidance

Monitor is a personal app for one person, Justin. There are no other users to support.

- Optimize for the best app on the current versions of Codex, Claude, and macOS. Do not retain old APIs, configuration formats, or integration paths just for backward compatibility.
- Breaking changes and new setup requirements are acceptable. When Justin requests a feature, assume he is willing to update the app, source apps, plugins, hooks, and local configuration immediately. Provide concrete upgrade/install steps and call out any required restart or hook trust review.
- Prefer replacing obsolete implementations over adding compatibility layers or long deprecation periods. Keep fallbacks only when they serve a present-day capability gap or failure mode, and explain that purpose.
- This does not authorize deleting personal data. Preserve workstream names, membership, priority, snoozes, and archives unless a requested change requires a reset; explain any necessary data loss before doing it.
- Work directly on `main` and push completed changes. Do not create pull requests or a review workflow for this project.
- During iteration, commit and push without bumping the app version or creating a GitHub release for each push. Create a release and choose its version only when Justin asks. Local builds and installs can use the current version; refresh a plugin cachebuster when needed for Codex to pick up changed plugin code.
- Keep the existing Codex and Claude harnesses. Session status belongs to the source app; grouping, ordering, snoozing, and local archiving belong to Monitor.
- Keep integrations local. Never persist prompts, responses, tool arguments, credentials, or raw hook payloads. Use synthetic fixtures in tests.
- Use the Midnight palette with prominent blue accents. Status colors must not rely on red versus green; retain text labels and distinct marker shapes, and preserve readable contrast on dark and selected surfaces.

Run `npm run check` for implementation changes and `npm run smoke` when desktop integration or UI behavior changes. Use Node 24 or newer. Keep validation claims specific about fixture tests versus live source-app observations.
