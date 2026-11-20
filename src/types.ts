export type TaskPriority = "P0" | "P1" | "P2" | "P3";

export type TaskKind =
  | "ci_failed"
  | "pr_review"
  | "pr_conflict"
  | "issue_triage"
  | "issue_reply"
  | "issue_stale"
  | "docs_gap"
  | "release_ready";

export type TaskAction =
  | "comment"
  | "add_labels"
  | "assign"
  | "close"
  | "review_comment"
  | "approve"
  | "request_changes"
  | "snooze";

export interface RepoRecord {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string | null;
  htmlUrl: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stars: number;
  forks: number;
  watchers: number;
  openIssues: number;
  license: string | null;
  defaultBranch: string;
  pushedAt: string | null;
  updatedAt: string | null;
  latestReleaseTag: string | null;
  latestReleaseAt: string | null;
  releaseDownloads: number;
  contributors: number;
  hasReadme: boolean;
  health: number;
  syncedAt: string;
}

export interface IssueRecord {
  id: number;
  repoId: number;
  repoFullName: string;
  number: number;
  title: string;
  body: string;
  state: string;
  author: string | null;
  labels: string[];
  comments: number;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
}

export interface PullRecord extends IssueRecord {
  draft: boolean;
  mergeable: boolean | null;
  ciStatus: "success" | "failure" | "pending" | "unknown";
  headSha: string | null;
  requestedReviewers: string[];
}

export interface WorkItem {
  id: string;
  kind: TaskKind;
  priority: TaskPriority;
  repo: string;
  repoUrl: string;
  targetType: "issue" | "pull" | "repo";
  number: number | null;
  title: string;
  reason: string;
  suggestion: string;
  url: string;
  ageHours: number;
  activityAt: string;
  labels: string[];
  actions: TaskAction[];
}

export interface Achievement {
  id: string;
  title: string;
  description: string;
  repo: string | null;
  level: "milestone" | "community" | "quality";
}

export interface ProjectView extends RepoRecord {
  openPullRequests: number;
  contributors: number;
  healthLabel: "健康" | "需要关注" | "高风险";
  latestActivity: string | null;
}

export interface OverviewStats {
  repos: number;
  stars: number;
  forks: number;
  contributors: number;
  openIssues: number;
  openPullRequests: number;
  releases: number;
  releaseDownloads: number;
  starDelta: number;
  firstSnapshotAt: string | null;
}

export interface WorkbenchSnapshot {
  version: 1;
  configured: boolean;
  account: {
    login: string;
    name: string | null;
    avatarUrl: string;
  } | null;
  generatedAt: string;
  syncedAt: string | null;
  stats: OverviewStats;
  projects: ProjectView[];
  tasks: WorkItem[];
  achievements: Achievement[];
  recentActions: AuditRecord[];
  setupMessage?: string;
}

export interface AuditRecord {
  id: string;
  createdAt: string;
  actor: string;
  tool: string;
  repo: string;
  target: string;
  summary: string;
  status: "prepared" | "completed" | "failed" | "cancelled";
  detail: string;
}

export interface PreparedAction {
  id: string;
  taskId: string;
  action: TaskAction;
  summary: string;
  preview: Record<string, unknown>;
  repo: string;
  targetType: "issue" | "pull" | "repo";
  targetNumber: number | null;
  expiresAt: string;
}

export interface ActionRequest {
  taskId: string;
  action: TaskAction;
  comment?: string;
  labels?: string[];
  assignees?: string[];
}

export interface AccountOptions {
  includePrivate: boolean;
  includeForks: boolean;
  includeArchived: boolean;
  includeOrganizations: boolean;
  exclude: string[];
}

export interface AppConfig {
  version: 1;
  github: {
    token?: string;
    apiBaseUrl: string;
  };
  account: AccountOptions;
  workbench: {
    port: number;
    syncMinutes: number;
  };
}
