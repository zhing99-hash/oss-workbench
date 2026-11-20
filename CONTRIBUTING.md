# Contributing

## Before you start

- For a bug, open an Issue with the version, operating system, AI assistant, and reproduction.
- For a new AI assistant adapter, explain which extension mechanism it uses: MCP tools, MCP Apps, Skill, plugin, or CLI. Do not duplicate GitHub business logic in an adapter.
- For a new GitHub write action, include the preview, permission, failure, and audit behavior.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

Requirements: Node.js 22.5+.

## Design rules

1. GitHub remains the source of truth. Do not build a parallel issue tracker.
2. MCP tools must remain useful without interactive UI.
3. Every write action must follow `prepare → preview → confirm → commit`.
4. Never expose a GitHub token through tool output, logs, or configuration views.
5. Label approximate or partial statistics accurately.
6. Keep the workbench usable in a narrow conversation pane and in a browser.
7. Prefer local SQLite and zero external infrastructure for the default mode.

## Pull requests

- Keep changes focused.
- Add or update tests for task rules, permissions, and MCP contracts.
- Update README when installation or user-facing behavior changes.
- Do not commit generated `dist/` files, local databases, or tokens.
- Describe any change to the security boundary explicitly.

## Commit style

Use short imperative messages, for example:

```text
feat: add OpenClaw install adapter
fix: preserve action preview on modal click
docs: clarify contributor statistics
```

## License

Contributions are accepted under the MIT License.
