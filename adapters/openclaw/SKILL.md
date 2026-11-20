---
name: oss-workbench
description: Manage GitHub open-source projects from OpenClaw. Use for opening the OSS Workbench dashboard, scanning maintainer tasks, reviewing project achievements and statistics, triaging issues, or reviewing pull requests. Always preview GitHub writes before asking for confirmation.
---

# OSS Workbench

Use the `oss-workbench` MCP server to manage the repositories visible to the configured GitHub account.

- “打开开源工作台” → call `workbench_open`. The MCP Apps host should render the interactive workbench.
- “扫描项目” → call `workbench_scan`, then summarize P0/P1 items in Chinese.
- “看看成果” → call `workbench_snapshot`; report GitHub-native totals and label local trend data accurately.
- Any write action → call `task_prepare_action` first, show the complete preview, and only after explicit approval call `task_commit_action` with `confirm: true`.
- Never merge a PR, publish a release, delete a repository, or change permissions autonomously.
- Do not claim an operation succeeded until `task_commit_action` returns `ok: true`.
