import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { WorkbenchApp } from "./app.js";
import { ActionError, cancelAction, commitAction, prepareAction } from "./actions.js";
import { GitHubError } from "./github.js";
import type { ActionRequest, TaskAction } from "./types.js";

export const WORKBENCH_URI = "ui://oss-workbench/workbench.html";

const actionSchema = {
  type: "string",
  enum: ["comment", "add_labels", "assign", "close", "review_comment", "approve", "request_changes", "snooze"],
} as const;

const TOOLS = [
  {
    name: "workbench_open",
    title: "打开开源项目工作台",
    description: "在支持的 AI 助手中打开交互式工作台，展示待处理事项、开源成果、项目统计和可执行操作。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { ui: { resourceUri: WORKBENCH_URI }, "ui/resourceUri": WORKBENCH_URI },
  },
  {
    name: "workbench_scan",
    title: "扫描开源项目",
    description: "同步授权 GitHub 账号下的开源项目、Issue、PR、Release 和贡献者数据，并重新生成待办。默认会实际访问 GitHub。",
    inputSchema: {
      type: "object",
      properties: {
        force: { type: "boolean", description: "是否忽略缓存立即同步，默认 true。" },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "workbench_snapshot",
    title: "读取工作台快照",
    description: "读取本地缓存的工作台数据，包括项目统计、成果、待办和最近操作。不会修改 GitHub。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "project_list",
    title: "列出自有开源项目",
    description: "列出已同步的授权账号开源项目、Stars、语言、健康度和待处理 PR 数量。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "account_status",
    title: "读取授权与同步状态",
    description: "检查 GitHub 授权、同步时间、数据目录和平台安装状态。不会输出 Token。",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "task_prepare_action",
    title: "预览待办处理动作",
    description: "为待办事项准备评论、标签、指派、关闭或 PR 审查操作。只生成预览，不修改 GitHub。用户确认后必须调用 task_commit_action。",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "workbench_snapshot 返回的待办 ID。" },
        action: actionSchema,
        comment: { type: "string", description: "评论或审查正文。comment、review_comment、approve、request_changes 通常需要。" },
        labels: { type: "array", items: { type: "string" }, description: "添加的标签。" },
        assignees: { type: "array", items: { type: "string" }, description: "指派的 GitHub 用户名。" },
      },
      required: ["taskId", "action"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "task_commit_action",
    title: "确认执行待办动作",
    description: "执行已预览的 GitHub 操作。此工具会修改 GitHub，必须由用户在看到预览后明确确认。",
    inputSchema: {
      type: "object",
      properties: {
        actionId: { type: "string", description: "task_prepare_action 返回的操作 ID。" },
        confirm: { type: "boolean", description: "必须为 true，表示用户已确认预览。" },
      },
      required: ["actionId", "confirm"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "task_cancel_action",
    title: "取消待办动作",
    description: "取消一个尚未执行的待办操作预览。",
    inputSchema: {
      type: "object",
      properties: { actionId: { type: "string" } },
      required: ["actionId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "audit_list",
    title: "查看操作审计",
    description: "查看本机记录的准备、执行和失败操作，不会修改 GitHub。",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", minimum: 1, maximum: 100 } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

function text(value: string) {
  return { type: "text" as const, text: value };
}

function result(data: Record<string, unknown>, message: string) {
  return {
    content: [text(message)],
    structuredContent: data,
  };
}

function friendlyError(error: unknown): never {
  if (error instanceof ActionError) {
    throw new McpError(ErrorCode.InvalidRequest, error.message, { status: error.status });
  }
  if (error instanceof GitHubError) {
    const hint = error.status === 401
      ? "请检查 GITHUB_TOKEN 是否有效，或运行 oss-workbench auth --token <token>。"
      : error.status === 403
        ? "GitHub 拒绝访问，请检查 Token 权限或 API 速率限制。"
        : "";
    throw new McpError(ErrorCode.InternalError, `${error.message}${hint ? ` ${hint}` : ""}`);
  }
  throw new McpError(ErrorCode.InternalError, (error as Error).message || "未知错误");
}

function stripNulls<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function createMcpServer(app: WorkbenchApp): Server {
  const server = new Server(
    { name: "oss-workbench", version: "0.1.0" },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: [
        "OSS Workbench is a local-first GitHub open-source project management server.",
        "Use workbench_open when the user asks to open the project workbench or manage open-source work.",
        "Use workbench_scan to refresh GitHub data, then summarize actionable items in Chinese.",
        "Never execute task_commit_action without first calling task_prepare_action and showing its preview to the user.",
        "Do not claim an action succeeded until task_commit_action returns ok=true.",
        "The server only manages repositories visible to the configured GitHub account; it never invents repository data.",
      ].join(" "),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS.map((tool) => ({ ...tool })) }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{
      uri: WORKBENCH_URI,
      name: "OSS Workbench",
      description: "交互式开源项目管理工作台",
      mimeType: "text/html;profile=mcp-app",
    }],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== WORKBENCH_URI) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
    }
    return {
      contents: [{
        uri: WORKBENCH_URI,
        mimeType: "text/html;profile=mcp-app",
        text: app.workbenchHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { connectDomains: [], resourceDomains: [] },
          },
        },
      }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case "workbench_open": {
          await app.ensureSynced();
          const snapshot = app.snapshot();
          return result(
            { snapshot, uri: WORKBENCH_URI },
            snapshot.configured
              ? `开源工作台已打开。当前 ${snapshot.tasks.length} 项待处理，${snapshot.projects.length} 个开源项目。`
              : app.setupMessage(),
          );
        }
        case "workbench_scan": {
          const sync = await app.sync(args.force !== false);
          const snapshot = app.snapshot();
          return result(
            { sync, snapshot },
            `扫描完成：${sync.repositories} 个项目、${sync.issues} 个 Issue、${sync.pulls} 个 PR，发现 ${snapshot.tasks.length} 项待处理。耗时 ${Math.round(sync.durationMs / 1000)} 秒。`,
          );
        }
        case "workbench_snapshot": {
          const snapshot = app.snapshot();
          return result({ snapshot }, snapshot.configured ? `共 ${snapshot.tasks.length} 项待处理。` : app.setupMessage());
        }
        case "project_list": {
          const snapshot = app.snapshot();
          const projects = snapshot.projects.map((project) => ({
            name: project.fullName,
            description: project.description,
            stars: project.stars,
            forks: project.forks,
            language: project.language,
            openPulls: project.openPullRequests,
            health: project.health,
            healthLabel: project.healthLabel,
            url: project.htmlUrl,
          }));
          return result({ projects }, `已列出 ${projects.length} 个开源项目。`);
        }
        case "account_status": {
          const snapshot = app.snapshot();
          return result({
            configured: app.configured,
            account: snapshot.account,
            syncedAt: snapshot.syncedAt,
            dataHome: process.env.OSS_WORKBENCH_HOME || "~/.oss-workbench",
            stats: snapshot.stats,
          }, app.configured ? `GitHub 账号 ${snapshot.account?.login ?? ""} 已连接。` : app.setupMessage());
        }
        case "task_prepare_action": {
          const prepared = prepareAction(app.store, stripNulls({
            taskId: String(args.taskId ?? ""),
            action: String(args.action ?? "") as TaskAction,
            comment: args.comment == null ? undefined : String(args.comment),
            labels: Array.isArray(args.labels) ? args.labels.map(String) : undefined,
            assignees: Array.isArray(args.assignees) ? args.assignees.map(String) : undefined,
          }) as ActionRequest);
          return result({ prepared }, `已生成预览：${prepared.summary}。请向用户展示预览，确认后再提交。`);
        }
        case "task_commit_action": {
          if (args.confirm !== true) {
            throw new ActionError("必须明确传入 confirm=true，表示用户已确认操作预览。");
          }
          const committed = await commitAction(app.store, app.client, String(args.actionId ?? ""));
          return result({ committed }, `${committed.message}${committed.url ? ` ${committed.url}` : ""}`);
        }
        case "task_cancel_action": {
          cancelAction(app.store, String(args.actionId ?? ""));
          return result({ cancelled: true }, "操作已取消。");
        }
        case "audit_list": {
          const limit = Math.min(100, Math.max(1, Number(args.limit ?? 20)));
          const records = app.store.listAudit(limit);
          return result({ records }, `最近 ${records.length} 条操作记录。`);
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    } catch (error) {
      friendlyError(error);
    }
  });

  return server;
}

export async function serveStdio(app: WorkbenchApp): Promise<void> {
  const server = createMcpServer(app);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
