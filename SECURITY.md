# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability involving GitHub tokens, local file access, command execution, or unauthorized GitHub writes.

Use GitHub's private vulnerability reporting for this repository. If that is unavailable, contact the maintainer through the profile at <https://github.com/zhing99-hash> without including secrets in the first message.

We aim to acknowledge a report within 7 days. Please include:

- affected version or commit,
- minimal reproduction,
- required permissions,
- expected and actual behavior,
- whether a real GitHub token or repository was affected.

## Security model

OSS Workbench is a local-first application.

- The MCP server reads GitHub data using the token supplied through `GITHUB_TOKEN`, `GH_TOKEN`, or the local config file.
- The token is never returned by MCP tools or printed by `oss-workbench config`.
- The local workbench binds to `127.0.0.1` by default and validates browser origins.
- GitHub writes require a prepared action and an explicit confirmation.
- Merging pull requests, publishing releases, deleting repositories, and changing permissions are deliberately not automated.
- Audit records are stored locally in SQLite.

## User responsibilities

- Use a fine-grained token with the smallest repository and permission scope.
- Do not paste tokens into AI chats, Skills, Issues, or commits.
- Review every action preview before confirming it.
- Treat the local config directory as sensitive.
- Review third-party MCP Apps host plugins before installing them.

## Out of scope

- Vulnerabilities in GitHub itself.
- Vulnerabilities in third-party AI assistants or MCP Apps host plugins.
- Damage caused by granting a token broader permissions than intended.
- Data loss caused by deleting the local `~/.oss-workbench` directory.
