# Codex adapter

OSS Workbench is a standard stdio MCP server. Configure it once with:

```bash
codex mcp add oss-workbench -- npx -y github:zhing99-hash/oss-workbench serve
```

Or add this to `~/.codex/config.toml`:

```toml
[mcp_servers.oss-workbench]
command = "npx"
args = ["-y", "github:zhing99-hash/oss-workbench", "serve"]
```

Start a new Codex session, run `/mcp`, and ask:

> 打开开源工作台

Codex terminal hosts may render only the textual summary; run `oss-workbench workbench` to open the full browser dashboard.
