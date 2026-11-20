import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { WorkbenchApp } from "./app.js";
import { readConfig, saveConfig, publicConfig, resolveToken } from "./config.js";
import { installAll, installAssistant, installationStatus, type Assistant } from "./install.js";
import { serveStdio } from "./mcp.js";
import { startHttpServer } from "./http.js";
import { builtWorkbenchHtml, appHome } from "./paths.js";

function makeApp(): WorkbenchApp {
  return new WorkbenchApp();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function version(): string {
  return "0.1.0";
}

const program = new Command();

program
  .name("oss-workbench")
  .description("开源工作台：在 AI 助手中管理 GitHub 开源项目")
  .version(version());

program
  .command("serve")
  .description("启动 MCP 服务（默认 stdio；指定 --http 时同时提供工作台）")
  .option("--http", "使用 Streamable HTTP 并启动本地工作台")
  .option("--port <port>", "HTTP 端口", (value) => Number(value))
  .option("--open", "打开浏览器工作台")
  .action(async (options: { http?: boolean; port?: number; open?: boolean }) => {
    const app = makeApp();
    if (!options.http) {
      await serveStdio(app);
      return;
    }
    const server = await startHttpServer(app, {
      ...(options.port ? { port: options.port } : {}),
      openBrowser: Boolean(options.open),
    });
    process.stderr.write(`OSS Workbench: ${server.url}\nMCP endpoint: http://127.0.0.1:${server.port}/mcp\n`);
    const shutdown = async () => {
      await server.close();
      app.close();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
  });

program
  .command("workbench")
  .description("启动浏览器版开源工作台")
  .option("--port <port>", "HTTP 端口", (value) => Number(value))
  .option("--no-open", "不自动打开浏览器")
  .action(async (options: { port?: number; open?: boolean }) => {
    const app = makeApp();
    const server = await startHttpServer(app, {
      ...(options.port ? { port: options.port } : {}),
      openBrowser: options.open !== false,
    });
    process.stdout.write(`开源工作台已启动：${server.url}\n按 Ctrl+C 停止。\n`);
    process.on("SIGINT", async () => {
      await server.close();
      app.close();
      process.exit(0);
    });
  });

program
  .command("auth")
  .description("配置 GitHub Token（也可用 GITHUB_TOKEN / GH_TOKEN 环境变量）")
  .option("--token <token>", "GitHub fine-grained token")
  .option("--from-gh", "尝试从 gh auth token 读取")
  .action((options: { token?: string; fromGh?: boolean }) => {
    let token = options.token?.trim();
    if (!token && options.fromGh) {
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("gh auth token 失败，请确认 GitHub CLI 已登录。");
      token = result.stdout.trim();
    }
    if (!token) throw new Error("请传入 --token，或使用 --from-gh。推荐使用 fine-grained token。");
    if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
      process.stderr.write("警告：Token 格式不像 GitHub 个人访问令牌，仍会保存。\n");
    }
    const config = readConfig();
    config.github.token = token;
    saveConfig(config);
    process.stdout.write("GitHub Token 已保存到本机配置。建议同时设置 GITHUB_TOKEN 以便覆盖本地配置。\n");
  });

program
  .command("sync")
  .description("同步授权账号下的全部开源项目")
  .option("--json", "输出机器可读 JSON")
  .action(async (options: { json?: boolean }) => {
    const app = makeApp();
    const result = await app.sync(true);
    if (options.json) printJson(result);
    else {
      process.stdout.write(
        `同步完成：${result.repositories} 个项目，${result.issues} 个 Issue，${result.pulls} 个 PR，耗时 ${Math.round(result.durationMs / 1000)} 秒。\n`,
      );
      for (const warning of result.warnings) process.stdout.write(`警告：${warning}\n`);
    }
    app.close();
  });

program
  .command("scan")
  .description("输出当前待办和成果统计")
  .option("--json", "输出机器可读 JSON")
  .action((options: { json?: boolean }) => {
    const app = makeApp();
    const snapshot = app.snapshot();
    if (options.json) printJson(snapshot);
    else {
      process.stdout.write(`开源项目：${snapshot.stats.repos} 个，Stars：${snapshot.stats.stars}，待办：${snapshot.tasks.length} 项\n`);
      for (const task of snapshot.tasks.slice(0, 20)) {
        process.stdout.write(`[${task.priority}] ${task.repo}${task.number ? `#${task.number}` : ""} ${task.title}\n  ${task.reason}\n`);
      }
    }
    app.close();
  });

program
  .command("doctor")
  .description("检查授权、工作台构建和平台安装状态")
  .option("--json", "输出机器可读 JSON")
  .action(async (options: { json?: boolean }) => {
    const app = makeApp();
    let github: { ok: boolean; login?: string; error?: string } = { ok: false };
    if (app.configured) {
      try {
        const user = await app.client.getAuthenticatedUser();
        github = { ok: true, login: user.login };
      } catch (error) {
        github = { ok: false, error: (error as Error).message };
      }
    } else {
      github = { ok: false, error: "GitHub Token 未配置" };
    }
    const report = {
      version: version(),
      node: process.version,
      sqlite: true,
      github,
      syncedAt: app.lastSyncAt(),
      workbenchBuilt: existsSync(builtWorkbenchHtml()),
      dataHome: appHome(),
      assistants: installationStatus(),
    };
    if (options.json) printJson(report);
    else {
      process.stdout.write(`OSS Workbench ${report.version}\n`);
      process.stdout.write(`Node: ${report.node}\n`);
      process.stdout.write(`GitHub: ${github.ok ? `已连接 ${github.login}` : `未连接（${github.error}）`}\n`);
      process.stdout.write(`工作台资源: ${report.workbenchBuilt ? "已构建" : "未构建，请运行 npm run build"}\n`);
      process.stdout.write(`数据目录: ${report.dataHome}\n`);
      for (const assistant of report.assistants) {
        process.stdout.write(`- ${assistant.assistant}: ${assistant.detected ? "已检测到配置" : "未安装"}\n`);
      }
    }
    app.close();
    if (!github.ok) process.exitCode = 1;
  });

program
  .command("install")
  .description("安装到 AI 助手：workbuddy、codex、openclaw、dsh 或 all")
  .argument("[assistant]", "目标助手", "all")
  .action((assistant: string) => {
    const allowed: Assistant[] = ["workbuddy", "codex", "openclaw", "dsh"];
    if (assistant === "all") {
      for (const outcome of installAll()) {
        process.stdout.write(`[${outcome.status}] ${outcome.assistant}: ${outcome.message}\n  ${outcome.path}\n`);
      }
      return;
    }
    if (!allowed.includes(assistant as Assistant)) {
      throw new Error(`不支持的助手：${assistant}。可选：${allowed.join("、")}、all`);
    }
    for (const outcome of installAssistant(assistant as Assistant)) {
      process.stdout.write(`[${outcome.status}] ${outcome.assistant}: ${outcome.message}\n  ${outcome.path}\n`);
    }
  });

program
  .command("status")
  .description("查看平台安装状态")
  .action(() => {
    printJson(installationStatus());
  });

program
  .command("config")
  .description("查看本机配置（Token 已脱敏）")
  .action(() => {
    printJson(publicConfig());
  });

program
  .command("token")
  .description("检查当前是否解析到 GitHub Token")
  .action(() => {
    const config = readConfig();
    process.stdout.write(resolveToken(config) ? "GitHub Token: 已配置\n" : "GitHub Token: 未配置\n");
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`错误：${(error as Error).message}\n`);
  process.exit(1);
});
