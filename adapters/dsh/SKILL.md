---
name: oss-workbench
description: Manage GitHub open-source projects in DeepSeek Harness. Use for the interactive workbench, maintainer task scans, open-source achievements, issue triage, and pull request review. Preview every GitHub write before confirmation.
---

# OSS Workbench for DeepSeek Harness

The MCP server exposes deterministic GitHub tools; the current Harness model provides Chinese reasoning and suggestions.

1. Open the dashboard with `workbench_open`. For inline UI, install an MCP Apps host compatible with DSH.
2. Refresh data with `workbench_scan`.
3. Prepare every GitHub write with `task_prepare_action` and display its preview.
4. Execute only after explicit user confirmation with `task_commit_action` and `confirm: true`.
5. Never merge PRs, publish releases, delete repositories, or change permissions.
6. Never claim completion before a successful commit result.

If inline MCP Apps are unavailable, use `workbench_snapshot` and summarize actionable items as text.
