import type { Store } from "./db.js";
import type {
  Achievement,
  AuditRecord,
  IssueRecord,
  OverviewStats,
  ProjectView,
  PullRecord,
  RepoRecord,
  TaskAction,
  TaskKind,
  TaskPriority,
  WorkItem,
  WorkbenchSnapshot,
} from "./types.js";
import { daysSince, hoursSince, unique } from "./utils.js";

const priorityRank: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const issueActions: TaskAction[] = ["add_labels", "assign", "comment", "close", "snooze"];
const pullActions: TaskAction[] = ["review_comment", "approve", "request_changes", "comment", "snooze"];

export function taskId(repo: string, kind: TaskKind, number: number | null): string {
  return `${repo}:${kind}:${number ?? "repo"}`;
}

function makeIssueTask(
  repo: RepoRecord,
  issue: IssueRecord,
  kind: TaskKind,
  priority: TaskPriority,
  reason: string,
  suggestion: string,
): WorkItem {
  return {
    id: taskId(repo.fullName, kind, issue.number),
    kind,
    priority,
    repo: repo.fullName,
    repoUrl: repo.htmlUrl,
    targetType: "issue",
    number: issue.number,
    title: issue.title,
    reason,
    suggestion,
    url: issue.htmlUrl,
    ageHours: hoursSince(issue.updatedAt),
    activityAt: issue.updatedAt,
    labels: issue.labels,
    actions: issueActions,
  };
}

export function deriveTasks(store: Store, now = Date.now()): WorkItem[] {
  const repos = new Map(store.listRepos().map((repo) => [repo.fullName, repo]));
  const tasks: WorkItem[] = [];

  for (const pull of store.listPulls()) {
    const repo = repos.get(pull.repoFullName);
    if (!repo) continue;
    const age = hoursSince(pull.updatedAt, now);
    const base = {
      id: taskId(repo.fullName, "pr_review" as const, pull.number),
      priority: "P1" as TaskPriority,
      repo: repo.fullName,
      repoUrl: repo.htmlUrl,
      targetType: "pull" as const,
      number: pull.number,
      title: pull.title,
      url: pull.htmlUrl,
      ageHours: age,
      activityAt: pull.updatedAt,
      labels: pull.labels,
      actions: pullActions,
    };

    if (pull.ciStatus === "failure") {
      tasks.push({
        ...base,
        id: taskId(repo.fullName, "ci_failed", pull.number),
        kind: "ci_failed",
        priority: "P0",
        reason: `CI 检查失败，已等待 ${Math.round(age)} 小时。`,
        suggestion: "查看失败检查，生成修复建议，并先提交审查评论。",
      });
    }

    if (pull.mergeable === false) {
      tasks.push({
        ...base,
        id: taskId(repo.fullName, "pr_conflict", pull.number),
        kind: "pr_conflict",
        priority: "P1",
        reason: "与目标分支存在冲突，当前无法合并。",
        suggestion: "提醒贡献者解决冲突，并说明需要更新的文件与分支。",
      });
    }

    if (!pull.draft) {
      const reviewerHint = pull.requestedReviewers.length > 0
        ? `等待 ${pull.requestedReviewers.join("、")} 审查。`
        : "尚无明确审查人。";
      tasks.push({
        ...base,
        kind: "pr_review",
        reason: `${reviewerHint} 已等待 ${Math.round(age)} 小时。`,
        suggestion: age > 48
          ? "优先安排审查；可先生成中文审查摘要和风险点。"
          : "检查改动并决定评论、批准或请求修改。",
      });
    }
  }

  for (const issue of store.listIssues()) {
    const repo = repos.get(issue.repoFullName);
    if (!repo) continue;
    const age = hoursSince(issue.updatedAt, now);
    const issueAge = daysSince(issue.createdAt, now);

    if (issue.comments === 0 && hoursSince(issue.createdAt, now) >= 24) {
      tasks.push(makeIssueTask(
        repo, issue, "issue_reply", "P1",
        `新 Issue 已等待 ${Math.round(age)} 小时仍无回复。`,
        "阅读问题，确认是否可复现；先给出中文回复草稿。",
      ));
    }

    if (issue.labels.length === 0) {
      tasks.push(makeIssueTask(
        repo, issue, "issue_triage", "P2",
        "Issue 尚未分类，维护者难以排序和分派。",
        "建议添加 bug、documentation、enhancement 等标签并指定负责人。",
      ));
    }

    if (issueAge > 30) {
      tasks.push(makeIssueTask(
        repo, issue, "issue_stale", "P3",
        `Issue 已创建 ${Math.round(issueAge)} 天，仍处于打开状态。`,
        "确认是否仍然有效；请求补充信息、更新标签或关闭。",
      ));
    }
  }

  for (const repo of repos.values()) {
    const missing: string[] = [];
    if (!repo.description) missing.push("项目简介");
    if (!repo.license) missing.push("许可证");
    if (!repo.hasReadme) missing.push("README");
    if (missing.length > 0 && repo.health < 85) {
      tasks.push({
        id: taskId(repo.fullName, "docs_gap", null),
        kind: "docs_gap",
        priority: "P2",
        repo: repo.fullName,
        repoUrl: repo.htmlUrl,
        targetType: "repo",
        number: null,
        title: `完善 ${repo.name} 的项目资料`,
        reason: `缺少${missing.join("、")}，影响项目可信度和新贡献者上手。`,
        suggestion: "补齐项目资料；涉及创建文件时由 AI 助手生成草稿后人工提交。",
        url: repo.htmlUrl,
        ageHours: hoursSince(repo.updatedAt),
        activityAt: repo.updatedAt || repo.syncedAt,
        labels: [],
        actions: ["snooze"],
      });
    }
  }

  const grouped = new Map<string, WorkItem>();
  for (const candidate of tasks) {
    const key = `${candidate.repo}:${candidate.targetType}:${candidate.number ?? "repo"}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        ...candidate,
        id: key,
        reason: candidate.reason,
        labels: unique(candidate.labels),
      });
      continue;
    }
    const candidateWins = priorityRank[candidate.priority] < priorityRank[existing.priority];
    const mergeReason = (value: string) => value.replace(/[。；;]\s*$/, "");
    grouped.set(key, {
      ...existing,
      kind: candidateWins ? candidate.kind : existing.kind,
      priority: candidateWins ? candidate.priority : existing.priority,
      reason: unique([...existing.reason.split("；").map(mergeReason), mergeReason(candidate.reason)]).join("；"),
      suggestion: candidateWins ? candidate.suggestion : existing.suggestion,
      labels: unique([...existing.labels, ...candidate.labels]),
      actions: unique([...existing.actions, ...candidate.actions]),
      ageHours: Math.max(existing.ageHours, candidate.ageHours),
    });
  }

  return [...grouped.values()]
    .filter((task) => {
      const state = store.getTaskState(task.id);
      if (!state || (state.status !== "done" && state.status !== "snoozed")) return true;
      return Date.parse(task.activityAt) > Date.parse(state.updatedAt);
    })
    .sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || b.ageHours - a.ageHours)
    .slice(0, 120);
}

export function buildStats(store: Store): OverviewStats {
  const repos = store.listRepos();
  const issues = store.listIssues();
  const openPulls = store.openPullCount();
  const earliest = store.earliestSnapshot();
  const stars = repos.reduce((sum, repo) => sum + repo.stars, 0);
  const forks = repos.reduce((sum, repo) => sum + repo.forks, 0);
  const releases = store.releaseCount();
  const releaseDownloads = repos.reduce((sum, repo) => sum + repo.releaseDownloads, 0);
  return {
    repos: repos.length,
    stars,
    forks,
    contributors: store.contributorCount(),
    openIssues: issues.length,
    openPullRequests: openPulls,
    releases,
    releaseDownloads,
    starDelta: earliest ? stars - earliest.stars : 0,
    firstSnapshotAt: earliest?.day ?? null,
  };
}

export function projectViews(store: Store): ProjectView[] {
  const pullsByRepo = new Map<string, number>();
  for (const pull of store.listPulls()) {
    pullsByRepo.set(pull.repoFullName, (pullsByRepo.get(pull.repoFullName) ?? 0) + 1);
  }
  return store.listRepos().map((repo) => ({
    ...repo,
    openPullRequests: pullsByRepo.get(repo.fullName) ?? 0,
    healthLabel: repo.health >= 80 ? "健康" : repo.health >= 55 ? "需要关注" : "高风险",
    latestActivity: repo.pushedAt,
  }));
}

export function achievements(store: Store): Achievement[] {
  const repos = store.listRepos();
  const items: Achievement[] = [];
  const milestones = [
    { value: 10_000, title: "万星开源项目", id: "stars-10k" },
    { value: 1_000, title: "千星开源项目", id: "stars-1k" },
    { value: 100, title: "百星开源项目", id: "stars-100" },
  ];
  for (const repo of repos) {
    const milestone = milestones.find((entry) => repo.stars >= entry.value);
    if (milestone) {
      items.push({
        id: `${milestone.id}:${repo.fullName}`,
        title: milestone.title,
        description: `${repo.fullName} 已获得 ${repo.stars.toLocaleString("zh-CN")} Stars。`,
        repo: repo.fullName,
        level: "milestone",
      });
    }
    if (repo.latestReleaseTag) {
      items.push({
        id: `release:${repo.fullName}`,
        title: "持续发布",
        description: `${repo.fullName} 最新版本为 ${repo.latestReleaseTag}。`,
        repo: repo.fullName,
        level: "quality",
      });
    }
    if (repo.health >= 85) {
      items.push({
        id: `health:${repo.fullName}`,
        title: "项目资料健康",
        description: `${repo.fullName} 的文档、许可证和维护状态良好。`,
        repo: repo.fullName,
        level: "quality",
      });
    }
  }

  const totalStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
  if (totalStars > 0) {
    items.push({
      id: "portfolio-stars",
      title: "开源影响力",
      description: `账号下开源项目累计获得 ${totalStars.toLocaleString("zh-CN")} Stars。`,
      repo: null,
      level: "milestone",
    });
  }
  if (repos.length >= 5) {
    items.push({
      id: "portfolio-projects",
      title: "多项目维护者",
      description: `当前管理 ${repos.length} 个开源项目。`,
      repo: null,
      level: "community",
    });
  }
  return items.slice(0, 16);
}

export function buildSnapshot(
  store: Store,
  input: {
    configured: boolean;
    account: { login: string; name: string | null; avatarUrl: string } | null;
    setupMessage?: string;
  },
): WorkbenchSnapshot {
  const lastSyncAt = store.getMeta<string>("lastSyncAt");
  const snapshot: WorkbenchSnapshot = {
    version: 1,
    configured: input.configured,
    account: input.account,
    generatedAt: new Date().toISOString(),
    syncedAt: lastSyncAt,
    stats: buildStats(store),
    projects: projectViews(store),
    tasks: deriveTasks(store),
    achievements: achievements(store),
    recentActions: store.listAudit(12),
  };
  if (input.setupMessage) snapshot.setupMessage = input.setupMessage;
  return snapshot;
}

export function summarizeSnapshot(snapshot: WorkbenchSnapshot): Record<string, unknown> {
  return {
    configured: snapshot.configured,
    account: snapshot.account?.login ?? null,
    syncedAt: snapshot.syncedAt,
    stats: snapshot.stats,
    tasks: snapshot.tasks.slice(0, 8).map((task) => ({
      id: task.id,
      priority: task.priority,
      repo: task.repo,
      title: task.title,
      reason: task.reason,
      action: task.suggestion,
    })),
    totalTasks: snapshot.tasks.length,
    achievements: snapshot.achievements.slice(0, 5),
  };
}

export function priorityLabel(priority: TaskPriority): string {
  return { P0: "紧急", P1: "优先", P2: "普通", P3: "低优先" }[priority];
}

export function taskLabels(labels: string[]): string[] {
  return unique(labels.filter(Boolean));
}

export type { AuditRecord };
