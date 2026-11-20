import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { appHome, ensureAppHome, packageRoot } from "./paths.js";

export type Assistant = "workbuddy" | "codex" | "openclaw" | "dsh";

export const MCP_PACKAGE = "github:zhing99-hash/oss-workbench";

export const MCP_SERVER = {
  type: "stdio",
  command: "npx",
  args: ["-y", MCP_PACKAGE, "serve"],
  description: "OSS Workbench - GitHub 开源项目智能管理",
};

export interface InstallOutcome {
  assistant: Assistant;
  status: "installed" | "configured" | "manual" | "skipped";
  path: string;
  message: string;
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  const suffix = new Date().toISOString().replace(/[:.]/g, "-");
  cpSync(path, `${path}.bak-${suffix}`);
}

function writeJsonMerged(path: string, patch: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  backup(path);
  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`${path} 不是有效 JSON，请先修复或备份后重试。`);
    }
  }
  const servers = typeof existing.mcpServers === "object" && existing.mcpServers !== null
    ? existing.mcpServers as Record<string, unknown>
    : {};
  const next = {
    ...existing,
    mcpServers: { ...servers, ...patch },
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function copySkill(source: string, destination: string): void {
  if (!existsSync(source)) throw new Error(`找不到 Skill 模板：${source}`);
  mkdirSync(destination, { recursive: true });
  const target = source.endsWith("SKILL.md") ? join(destination, "SKILL.md") : destination;
  cpSync(source, target, { recursive: true });
}

export function installWorkbuddy(): InstallOutcome[] {
  const config = join(homedir(), ".workbuddy", "mcp.json");
  writeJsonMerged(config, { "oss-workbench": MCP_SERVER });
  const skillSource = join(packageRoot(), "adapters", "workbuddy", "SKILL.md");
  const skillDir = join(homedir(), ".workbuddy", "skills", "oss-workbench");
  copySkill(skillSource, skillDir);
  return [
    { assistant: "workbuddy", status: "installed", path: config, message: "已合并 MCP 配置并安装本地 Skill。" },
    { assistant: "workbuddy", status: "installed", path: skillDir, message: "重启 WorkBuddy 后，在对话中说“打开开源工作台”。" },
  ];
}

export function installCodex(): InstallOutcome[] {
  const config = join(homedir(), ".codex", "config.toml");
  mkdirSync(dirname(config), { recursive: true });
  backup(config);
  const before = existsSync(config) ? readFileSync(config, "utf8") : "";
  const block = [
    "# BEGIN OSS WORKBENCH (managed)",
    "[mcp_servers.oss-workbench]",
    `command = "${MCP_SERVER.command}"`,
    `args = ${JSON.stringify(MCP_SERVER.args)}`,
    "# END OSS WORKBENCH",
  ].join("\n");
  const withoutOld = before.replace(/# BEGIN OSS WORKBENCH \(managed\)[\s\S]*?# END OSS WORKBENCH\n?/g, "").trimEnd();
  writeFileSync(config, `${withoutOld}${withoutOld ? "\n\n" : ""}${block}\n`, "utf8");
  return [{ assistant: "codex", status: "configured", path: config, message: "已写入 Codex MCP 配置；重启 Codex 后生效。" }];
}

export function installOpenclaw(): InstallOutcome[] {
  const result = spawnSync("openclaw", [
    "mcp", "add", "oss-workbench",
    "--command", MCP_SERVER.command,
    "--arg", "-y", "--arg", MCP_PACKAGE, "--arg", "serve",
  ], { encoding: "utf8", shell: process.platform === "win32" });

  const skillSource = join(packageRoot(), "adapters", "openclaw", "SKILL.md");
  const skillDir = join(homedir(), ".openclaw", "skills", "oss-workbench");
  copySkill(skillSource, skillDir);

  if (result.status === 0) {
    return [
      { assistant: "openclaw", status: "configured", path: "openclaw config", message: "已通过 openclaw mcp add 注册服务。" },
      { assistant: "openclaw", status: "installed", path: skillDir, message: "已安装 OSS Workbench Skill。" },
    ];
  }
  return [
    {
      assistant: "openclaw",
      status: "manual",
      path: "openclaw mcp add",
      message: "未找到 openclaw CLI。请手动运行 README 中的 OpenClaw 配置命令；Skill 已安装。",
    },
  ];
}

export function installDsh(options: { profile?: string } = {}): InstallOutcome[] {
  const directory = join(ensureAppHome(), "adapters", "dsh");
  mkdirSync(directory, { recursive: true });
  const profile = options.profile || "web";
  const snippet = [
    "# 将以下配置行加入 DeepSeek Harness profile 的 cordis.patch.yml",
    "# dsh plugin --profile " + profile + " add ... 安装 MCP 客户端与 MCP Apps Host 后使用",
    "- id: oss-workbench",
    "  name: '@deepseek-ai/dsh-mcp-client'",
    "  config:",
    "    serverName: oss-workbench",
    "    transport: stdio",
    `    command: ${MCP_SERVER.command}`,
    `    args: ${JSON.stringify(MCP_SERVER.args)}`,
    "",
  ].join("\n");
  const path = join(directory, "oss-workbench.patch.yml");
  writeFileSync(path, snippet, "utf8");
  const skillSource = join(packageRoot(), "adapters", "dsh", "SKILL.md");
  if (existsSync(skillSource)) copySkill(skillSource, join(directory, "skill"));
  return [{
    assistant: "dsh",
    status: "manual",
    path,
    message: `已生成 ${profile} profile 配置片段。合并到 DSH 配置并重启后生效；详见 README。`,
  }];
}

export function installAssistant(assistant: Assistant): InstallOutcome[] {
  switch (assistant) {
    case "workbuddy": return installWorkbuddy();
    case "codex": return installCodex();
    case "openclaw": return installOpenclaw();
    case "dsh": return installDsh();
  }
}

export function installAll(): InstallOutcome[] {
  const outcomes: InstallOutcome[] = [];
  for (const assistant of ["workbuddy", "codex", "openclaw", "dsh"] as Assistant[]) {
    try {
      outcomes.push(...installAssistant(assistant));
    } catch (error) {
      outcomes.push({
        assistant,
        status: "manual",
        path: "-",
        message: `安装失败：${(error as Error).message}`,
      });
    }
  }
  return outcomes;
}

export function installationStatus(): Array<{ assistant: Assistant; detected: boolean; detail: string }> {
  const checks: Array<{ assistant: Assistant; paths: string[]; detail: string }> = [
    { assistant: "workbuddy", paths: [join(homedir(), ".workbuddy", "mcp.json")], detail: "WorkBuddy MCP 配置" },
    { assistant: "codex", paths: [join(homedir(), ".codex", "config.toml")], detail: "Codex config.toml" },
    { assistant: "openclaw", paths: [join(homedir(), ".openclaw", "skills", "oss-workbench")], detail: "OpenClaw Skill" },
    { assistant: "dsh", paths: [join(appHome(), "adapters", "dsh")], detail: "DSH 配置片段" },
  ];
  return checks.map((check) => ({
    assistant: check.assistant,
    detected: check.paths.some((path) => existsSync(path)),
    detail: check.detail,
  }));
}
