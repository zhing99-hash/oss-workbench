import { randomUUID } from "node:crypto";
import type { Store } from "./db.js";
import type { GitHubClient } from "./github.js";
import type { ActionRequest, AuditRecord, PreparedAction, TaskAction, WorkItem } from "./types.js";
import { deriveTasks } from "./scan.js";

const REVIEW_ACTIONS: TaskAction[] = ["approve", "request_changes", "review_comment"];
const MAX_PREVIEW_LENGTH = 1200;

export class ActionError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ActionError";
  }
}

function findTask(store: Store, id: string): WorkItem {
  const task = deriveTasks(store).find((entry) => entry.id === id);
  if (!task) throw new ActionError("待办事项不存在，可能已完成或已过期。", 404);
  return task;
}

function actionSummary(task: WorkItem, request: ActionRequest): string {
  const target = `${task.repo}${task.number ? `#${task.number}` : ""}`;
  switch (request.action) {
    case "comment": return `在 ${target} 发表评论`;
    case "add_labels": return `为 ${target} 添加标签：${(request.labels ?? []).join("、") || "未选择"}`;
    case "assign": return `将 ${target} 指派给：${(request.assignees ?? []).join("、") || "未选择"}`;
    case "close": return `关闭 ${target}${request.comment ? "并发表说明" : ""}`;
    case "review_comment": return `提交 ${target} 的审查评论`;
    case "approve": return `批准 ${target}`;
    case "request_changes": return `请求修改 ${target}`;
    case "snooze": return `稍后处理 ${target}`;
    default: return target;
  }
}

function requireText(request: ActionRequest, action: TaskAction): string {
  const text = request.comment?.trim();
  if (!text) throw new ActionError(`${action} 需要填写内容。`);
  if (text.length > 20_000) throw new ActionError("内容超过 GitHub 评论长度限制。");
  return text;
}

export function prepareAction(store: Store, request: ActionRequest): PreparedAction {
  const task = findTask(store, request.taskId);
  if (!task.actions.includes(request.action)) {
    throw new ActionError(`该事项不支持动作：${request.action}`);
  }

  if (request.action === "add_labels" && (!request.labels || request.labels.length === 0)) {
    throw new ActionError("请选择至少一个标签。");
  }
  if (request.action === "assign" && (!request.assignees || request.assignees.length === 0)) {
    throw new ActionError("请选择至少一位负责人。");
  }
  if (["comment", "review_comment", "approve", "request_changes"].includes(request.action)) {
    requireText(request, request.action);
  }

  const summary = actionSummary(task, request);
  const preview: Record<string, unknown> = {
    repo: task.repo,
    targetType: task.targetType,
    number: task.number,
    title: task.title,
    action: request.action,
    summary,
  };
  if (request.comment) preview.comment = request.comment.slice(0, MAX_PREVIEW_LENGTH);
  if (request.labels) preview.labels = request.labels;
  if (request.assignees) preview.assignees = request.assignees;

  const action: PreparedAction = {
    id: randomUUID(),
    taskId: task.id,
    action: request.action,
    summary,
    preview,
    repo: task.repo,
    targetType: task.targetType,
    targetNumber: task.number,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };

  const payload = {
    comment: request.comment ?? "",
    labels: request.labels ?? [],
    assignees: request.assignees ?? [],
    url: task.url,
  };
  store.savePreparedAction(action, payload);
  store.addAudit({
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    actor: store.getMeta<{ login?: string }>("account")?.login ?? "local-user",
    tool: "task_prepare_action",
    repo: task.repo,
    target: task.id,
    summary,
    status: "prepared",
    detail: JSON.stringify(preview),
  });
  return action;
}

export interface CommitResult {
  ok: boolean;
  actionId: string;
  message: string;
  url: string | null;
}

export async function commitAction(
  store: Store,
  client: GitHubClient,
  id: string,
): Promise<CommitResult> {
  const prepared = store.getPreparedAction(id);
  if (!prepared) throw new ActionError("操作不存在。", 404);
  if (prepared.status !== "pending") throw new ActionError(`操作已经是 ${prepared.status} 状态。`, 409);
  if (Date.parse(prepared.expiresAt) < Date.now()) {
    store.markPreparedAction(id, "cancelled");
    throw new ActionError("操作预览已过期，请重新选择。", 410);
  }

  const { repo, targetNumber, action, payload } = prepared;
  const comment = String(payload.comment ?? "");
  const labels = Array.isArray(payload.labels) ? payload.labels.map(String) : [];
  const assignees = Array.isArray(payload.assignees) ? payload.assignees.map(String) : [];
  let message = prepared.summary;
  let url: string | null = typeof payload.url === "string" ? payload.url : null;

  try {
    switch (action) {
      case "snooze":
        store.setTaskState(prepared.taskId, "snoozed");
        message = "已稍后处理。";
        break;
      case "comment":
        if (targetNumber == null) throw new ActionError("评论操作缺少目标编号。");
        await client.addIssueComment(repo, targetNumber, requireText({ taskId: prepared.taskId, action, comment }, action));
        break;
      case "close":
        if (targetNumber == null) throw new ActionError("关闭操作缺少目标编号。");
        if (comment.trim()) await client.addIssueComment(repo, targetNumber, comment.trim());
        if (prepared.targetType === "pull") await client.closePull(repo, targetNumber);
        else await client.closeIssue(repo, targetNumber);
        break;
      case "add_labels":
        if (targetNumber == null) throw new ActionError("标签操作缺少目标编号。");
        await client.addLabels(repo, targetNumber, labels);
        break;
      case "assign":
        if (targetNumber == null) throw new ActionError("指派操作缺少目标编号。");
        await client.addAssignees(repo, targetNumber, assignees);
        break;
      case "review_comment":
      case "approve":
      case "request_changes": {
        if (targetNumber == null) throw new ActionError("审查操作缺少目标编号。");
        const event = action === "approve" ? "APPROVE" : action === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
        await client.submitReview(repo, targetNumber, event, requireText({ taskId: prepared.taskId, action, comment }, action));
        break;
      }
      default:
        throw new ActionError(`未知动作：${action}`);
    }

    store.markPreparedAction(id, "completed");
    if (action !== "snooze") store.setTaskState(prepared.taskId, "done");
    store.addAudit(completedAudit(store, prepared, "completed", message));
    return { ok: true, actionId: id, message, url };
  } catch (error) {
    store.markPreparedAction(id, "failed");
    store.addAudit(completedAudit(store, prepared, "failed", (error as Error).message));
    throw error;
  }
}

function completedAudit(
  store: Store,
  prepared: PreparedAction & { payload?: Record<string, unknown> },
  status: AuditRecord["status"],
  detail: string,
): AuditRecord {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    actor: store.getMeta<{ login?: string }>("account")?.login ?? "local-user",
    tool: "task_commit_action",
    repo: prepared.repo,
    target: prepared.taskId,
    summary: prepared.summary,
    status,
    detail,
  };
}

export function cancelAction(store: Store, id: string): void {
  const prepared = store.getPreparedAction(id);
  if (!prepared) throw new ActionError("操作不存在。", 404);
  if (prepared.status !== "pending") throw new ActionError("只能取消待确认操作。", 409);
  store.markPreparedAction(id, "cancelled");
}

export function actionCatalog(task: WorkItem): Array<{ action: TaskAction; label: string }> {
  const names: Record<TaskAction, string> = {
    comment: "发表评论",
    add_labels: "添加标签",
    assign: "指派负责人",
    close: "关闭并说明",
    review_comment: "提交审查评论",
    approve: "批准 PR",
    request_changes: "请求修改",
    snooze: "稍后处理",
  };
  return task.actions.map((action) => ({ action, label: names[action] }));
}
