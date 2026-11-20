# Architecture

## Goals

OSS Workbench is an AI-assistant-native management layer over GitHub. It does not replace GitHub or create a second source of truth.

Core constraints:

- One business core, thin assistant adapters.
- Use the host assistant's model for language work by default.
- Work without interactive UI.
- Keep the default deployment local and dependency-light.
- Require explicit confirmation for GitHub writes.

## Components

```text
AI assistant / MCP Apps host
        │
        ├── MCP tools (stdio or Streamable HTTP)
        │       ├── workbench_*       scan and snapshot
        │       ├── project_list
        │       ├── task_prepare_*    preview writes
        │       ├── task_commit_*     execute confirmed writes
        │       └── audit_list
        │
        └── ui://oss-workbench/workbench.html
                │
                └── MCP Apps bridge or local /api/*
                          │
                    WorkbenchApp
                    ├── SQLite store
                    ├── GitHub REST client
                    ├── task engine
                    ├── action engine
                    └── installer
```

## Data flow

1. `workbench_scan` lists repositories visible to the authenticated account.
2. Open issues and pull requests are collected with GitHub search, filtered to the selected repositories.
3. Up to 24 recently active repositories are enriched with Release, README and contributor information.
4. Issues, pulls, repositories and a daily snapshot are written to local SQLite.
5. The task engine derives and merges actionable items.
6. `workbench_open` returns the MCP Apps resource and a compact textual summary.
7. A UI action calls `task_prepare_action`, which creates a ten-minute preview token and stores the exact payload.
8. After user confirmation, `task_commit_action` validates the token, calls GitHub, records the audit entry and marks the item handled.
9. If the underlying GitHub object changes later, the task can reappear because task completion is compared to the object's activity timestamp.

## Storage

SQLite tables:

- `repos`
- `items` (issues and pull requests)
- `contributors`
- `snapshots`
- `task_states`
- `pending_actions`
- `audit`
- `meta`

The database lives under `~/.oss-workbench/data.db` by default.

## Extension model

- MCP tools are the compatibility floor.
- Skills provide host-specific workflow guidance and trigger phrases.
- MCP Apps provide rich in-conversation UI where the host supports it.
- A browser workbench is always available.
- Installers only write host configuration and copy Skill assets; they do not duplicate GitHub logic.

## Deliberate exclusions from v0.1

- GitHub App OAuth
- automatic code changes
- merge and release automation
- multi-user server mode
- full historical traffic analytics
- GitHub Enterprise Server testing
