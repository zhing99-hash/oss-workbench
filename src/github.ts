import type { IssueRecord, PullRecord, RepoRecord } from "./types.js";

const API_VERSION = "2022-11-28";

export interface GitHubUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

export interface RawRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  watchers_count: number;
  open_issues_count: number;
  license: { spdx_id: string | null } | null;
  default_branch: string;
  pushed_at: string | null;
  updated_at: string | null;
}

export interface RawIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: Array<string | { name?: string }>;
  comments: number;
  assignees: Array<{ login: string }> | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  repository_url: string;
  pull_request?: { url: string };
  draft?: boolean;
}

export interface RawPull {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  mergeable: boolean | null;
  head: { sha: string };
  requested_reviewers: Array<{ login: string }>;
  labels: Array<{ name: string }>;
  comments: number;
  assignees: Array<{ login: string }> | null;
}

interface SearchResponse<T> {
  total_count: number;
  incomplete_results: boolean;
  items: T[];
}

interface CheckRunsResponse {
  check_runs: Array<{ status: string; conclusion: string | null }>;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly documentationUrl?: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubClient {
  private readonly token: string | null;
  private readonly baseUrl: string;

  constructor(options: { token: string | null; apiBaseUrl?: string }) {
    this.token = options.token;
    this.baseUrl = (options.apiBaseUrl || "https://api.github.com").replace(/\/$/, "");
  }

  get configured(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    allowNotFound = false,
  ): Promise<{ data: T; headers: Headers }> {
    if (!this.token) {
      throw new GitHubError("GitHub token is not configured. Set GITHUB_TOKEN or run `oss-workbench auth --token <token>`.", 401);
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "oss-workbench/0.1.0",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (allowNotFound && response.status === 404) {
      return { data: null as T, headers: response.headers };
    }

    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const body = (await response.json()) as { message?: string; documentation_url?: string };
        if (body.message) message = body.message;
        throw new GitHubError(message, response.status, body.documentation_url);
      } catch (error) {
        if (error instanceof GitHubError) throw error;
        throw new GitHubError(message, response.status);
      }
    }

    if (response.status === 204) {
      return { data: null as T, headers: response.headers };
    }

    return { data: (await response.json()) as T, headers: response.headers };
  }

  async getAuthenticatedUser(): Promise<GitHubUser> {
    const { data } = await this.request<GitHubUser>("/user");
    return data;
  }

  async listOwnedRepos(includeOrganizations = false): Promise<RawRepo[]> {
    const repos: RawRepo[] = [];
    const affiliation = includeOrganizations ? "owner,organization_member" : "owner";
    for (let page = 1; page <= 10; page += 1) {
      const { data } = await this.request<RawRepo[]>(
        `/user/repos?affiliation=${affiliation}&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      repos.push(...data);
      if (data.length < 100) break;
    }
    return repos;
  }

  async searchOpenItems(owner: string, kind: "issue" | "pr", scope: "user" | "org" = "user"): Promise<RawIssue[]> {
    const items: RawIssue[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const query = encodeURIComponent(`${scope}:${owner} is:${kind} is:open`);
      const { data } = await this.request<SearchResponse<RawIssue>>(
        `/search/issues?q=${query}&sort=updated&order=desc&per_page=100&page=${page}`,
      );
      items.push(...data.items);
      if (data.items.length < 100) break;
    }
    return items;
  }

  async getPull(repoFullName: string, number: number): Promise<RawPull | null> {
    const { data } = await this.request<RawPull>(`/repos/${repoFullName}/pulls/${number}`, {}, true);
    return data;
  }

  async getCiStatus(repoFullName: string, ref: string): Promise<PullRecord["ciStatus"]> {
    const { data } = await this.request<CheckRunsResponse>(
      `/repos/${repoFullName}/commits/${ref}/check-runs?per_page=100`,
      {},
      true,
    );
    if (!data || data.check_runs.length === 0) return "unknown";
    if (data.check_runs.some((check) => check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "action_required")) {
      return "failure";
    }
    if (data.check_runs.some((check) => check.status !== "completed")) return "pending";
    return "success";
  }

  async getLatestRelease(repoFullName: string): Promise<{ tag: string; publishedAt: string; downloads: number } | null> {
    const { data } = await this.request<{
      tag_name: string;
      published_at: string | null;
      assets: Array<{ download_count: number }>;
    }>(`/repos/${repoFullName}/releases/latest`, {}, true);
    if (!data) return null;
    return {
      tag: data.tag_name,
      publishedAt: data.published_at || "",
      downloads: data.assets.reduce((sum, asset) => sum + asset.download_count, 0),
    };
  }

  async hasReadme(repoFullName: string): Promise<boolean> {
    const { data } = await this.request<unknown>(`/repos/${repoFullName}/readme`, {}, true);
    return data !== null;
  }

  async listContributors(repoFullName: string): Promise<Array<{ login: string; contributions: number }>> {
    const { data } = await this.request<Array<{ login: string; contributions: number; type: string }>>(
      `/repos/${repoFullName}/contributors?per_page=100&anon=0`,
      {},
      true,
    );
    if (!data) return [];
    return data
      .filter((person) => person.type !== "Bot")
      .map((person) => ({ login: person.login, contributions: person.contributions }));
  }

  async addIssueComment(repoFullName: string, number: number, body: string): Promise<{ html_url: string }> {
    const { data } = await this.request<{ html_url: string }>(
      `/repos/${repoFullName}/issues/${number}/comments`,
      { method: "POST", body: JSON.stringify({ body }) },
    );
    return data;
  }

  async addLabels(repoFullName: string, number: number, labels: string[]): Promise<void> {
    await this.request(`/repos/${repoFullName}/issues/${number}/labels`, {
      method: "POST",
      body: JSON.stringify({ labels }),
    });
  }

  async addAssignees(repoFullName: string, number: number, assignees: string[]): Promise<void> {
    await this.request(`/repos/${repoFullName}/issues/${number}/assignees`, {
      method: "POST",
      body: JSON.stringify({ assignees }),
    });
  }

  async closeIssue(repoFullName: string, number: number): Promise<void> {
    await this.request(`/repos/${repoFullName}/issues/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
  }

  async closePull(repoFullName: string, number: number): Promise<void> {
    await this.request(`/repos/${repoFullName}/pulls/${number}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
  }

  async submitReview(
    repoFullName: string,
    number: number,
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
    body: string,
  ): Promise<void> {
    await this.request(`/repos/${repoFullName}/pulls/${number}/reviews`, {
      method: "POST",
      body: JSON.stringify({ event, body }),
    });
  }
}

export function toRepoRecord(
  repo: RawRepo,
  enrichment: {
    latestReleaseTag: string | null;
    latestReleaseAt: string | null;
    releaseDownloads: number;
    contributors: number;
    hasReadme: boolean;
    health: number;
  },
  syncedAt: string,
): RepoRecord {
  return {
    id: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description,
    htmlUrl: repo.html_url,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived,
    language: repo.language,
    stars: repo.stargazers_count,
    forks: repo.forks_count,
    watchers: repo.watchers_count,
    openIssues: repo.open_issues_count,
    license: repo.license?.spdx_id ?? null,
    defaultBranch: repo.default_branch,
    pushedAt: repo.pushed_at,
    updatedAt: repo.updated_at,
    latestReleaseTag: enrichment.latestReleaseTag,
    latestReleaseAt: enrichment.latestReleaseAt,
    releaseDownloads: enrichment.releaseDownloads,
    contributors: enrichment.contributors,
    hasReadme: enrichment.hasReadme,
    health: enrichment.health,
    syncedAt,
  };
}

export function toIssueRecord(issue: RawIssue, repoFullName: string): IssueRecord {
  return {
    id: issue.id,
    repoId: 0,
    repoFullName,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    state: issue.state,
    author: issue.user?.login ?? null,
    labels: issue.labels.map((label) => typeof label === "string" ? label : label.name ?? "").filter(Boolean),
    comments: issue.comments,
    assignees: (issue.assignees ?? []).map((person) => person.login),
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    htmlUrl: issue.html_url,
  };
}

export function toPullRecord(pull: RawPull, repoFullName: string, ciStatus: PullRecord["ciStatus"]): PullRecord {
  return {
    id: pull.id,
    repoId: 0,
    repoFullName,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    state: pull.state,
    author: pull.user?.login ?? null,
    labels: pull.labels.map((label) => label.name),
    comments: pull.comments,
    assignees: (pull.assignees ?? []).map((person) => person.login),
    createdAt: pull.created_at,
    updatedAt: pull.updated_at,
    htmlUrl: pull.html_url,
    draft: pull.draft,
    mergeable: pull.mergeable,
    ciStatus,
    headSha: pull.head.sha,
    requestedReviewers: pull.requested_reviewers.map((person) => person.login),
  };
}
