import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { healthScore, shouldIncludeRepo } from "../src/sync.js";
import { deriveTasks } from "../src/scan.js";
import { prepareAction, commitAction } from "../src/actions.js";
import type { GitHubClient, RawRepo } from "../src/github.js";
import type { AppConfig } from "../src/types.js";

const now = new Date().toISOString();
const twoDaysAgo = new Date(Date.now() - 48 * 3_600_000).toISOString();

function config(): AppConfig {
  return {
    version: 1,
    github: { apiBaseUrl: "https://api.github.com" },
    account: {
      includePrivate: false,
      includeForks: false,
      includeArchived: false,
      includeOrganizations: false,
      exclude: [],
    },
    workbench: { port: 3789, syncMinutes: 15 },
  };
}

function repo(overrides: Partial<RawRepo> = {}): RawRepo {
  return {
    id: 1,
    name: "core",
    full_name: "octo/core",
    owner: { login: "octo" },
    description: "Core project",
    html_url: "https://github.com/octo/core",
    private: false,
    fork: false,
    archived: false,
    language: "TypeScript",
    stargazers_count: 120,
    forks_count: 9,
    watchers_count: 120,
    open_issues_count: 4,
    license: { spdx_id: "MIT" },
    default_branch: "main",
    pushed_at: now,
    updated_at: now,
    ...overrides,
  };
}

function seedRepo(store: Store): void {
  store.upsertRepo({
    id: 1,
    owner: "octo",
    name: "core",
    fullName: "octo/core",
    description: null,
    htmlUrl: "https://github.com/octo/core",
    private: false,
    fork: false,
    archived: false,
    language: "TypeScript",
    stars: 120,
    forks: 9,
    watchers: 120,
    openIssues: 3,
    license: null,
    defaultBranch: "main",
    pushedAt: now,
    updatedAt: now,
    latestReleaseTag: null,
    latestReleaseAt: null,
    releaseDownloads: 0,
    contributors: 4,
    hasReadme: false,
    health: 62,
    syncedAt: now,
  });
}

describe("repository selection and health", () => {
  it("excludes private, fork, archived and excluded repos by default", () => {
    assert.equal(shouldIncludeRepo(repo(), config().account), true);
    assert.equal(shouldIncludeRepo(repo({ private: true }), config().account), false);
    assert.equal(shouldIncludeRepo(repo({ fork: true }), config().account), false);
    assert.equal(shouldIncludeRepo(repo({ archived: true }), config().account), false);
    assert.equal(shouldIncludeRepo(repo(), { ...config().account, exclude: ["OCTO/CORE"] }), false);
  });

  it("scores archived and undocumented projects below healthy projects", () => {
    const healthy = healthScore({
      archived: false,
      license: "MIT",
      description: "Good",
      hasReadme: true,
      pushedAt: now,
      openIssues: 4,
      openPulls: 1,
    });
    const weak = healthScore({
      archived: true,
      license: null,
      description: null,
      hasReadme: false,
      pushedAt: twoDaysAgo,
      openIssues: 120,
      openPulls: 40,
    });
    assert.equal(healthy, 100);
    assert.ok(weak < 50);
  });
});

describe("task generation", () => {
  it("prioritizes failed CI and creates issue and documentation tasks", () => {
    const store = new Store(":memory:");
    seedRepo(store);
    store.replaceItems(1, [
      {
        id: 100,
        repoId: 1,
        repoFullName: "octo/core",
        number: 7,
        title: "Crash on startup",
        body: "Steps...",
        state: "open",
        author: "user",
        labels: [],
        comments: 0,
        assignees: [],
        createdAt: twoDaysAgo,
        updatedAt: twoDaysAgo,
        htmlUrl: "https://github.com/octo/core/issues/7",
      },
      {
        id: 101,
        repoId: 1,
        repoFullName: "octo/core",
        number: 9,
        title: "Fix token refresh",
        body: "",
        state: "open",
        author: "dev",
        labels: [],
        comments: 2,
        assignees: [],
        createdAt: twoDaysAgo,
        updatedAt: now,
        htmlUrl: "https://github.com/octo/core/pull/9",
        draft: false,
        mergeable: true,
        ciStatus: "failure",
        headSha: "abc",
        requestedReviewers: [],
      },
    ]);

    const tasks = deriveTasks(store);
    assert.equal(tasks[0]?.kind, "ci_failed");
    assert.equal(tasks[0]?.priority, "P0");
    const issueTask = tasks.find((task) => task.number === 7 && task.targetType === "issue");
    assert.equal(issueTask?.kind, "issue_reply");
    assert.ok(issueTask?.reason.includes("尚未分类"));
    assert.equal(tasks.filter((task) => task.number === 9).length, 1);
    assert.ok(tasks.some((task) => task.kind === "docs_gap"));
    store.close();
  });
});

describe("two-phase actions", () => {
  it("only executes after prepare and records an audit entry", async () => {
    const store = new Store(":memory:");
    seedRepo(store);
    store.replaceItems(1, [{
      id: 100,
      repoId: 1,
      repoFullName: "octo/core",
      number: 7,
      title: "Crash on startup",
      body: "Steps...",
      state: "open",
      author: "user",
      labels: ["bug"],
      comments: 0,
      assignees: [],
      createdAt: twoDaysAgo,
      updatedAt: twoDaysAgo,
      htmlUrl: "https://github.com/octo/core/issues/7",
    }]);
    const task = deriveTasks(store).find((entry) => entry.kind === "issue_reply");
    assert.ok(task);

    const prepared = prepareAction(store, {
      taskId: task!.id,
      action: "comment",
      comment: "Thanks, please share the version.",
    });
    assert.equal(store.listAudit(1)[0]?.status, "prepared");

    let called = 0;
    const client = {
      addIssueComment: async () => {
        called += 1;
        return { html_url: "https://github.com/octo/core/issues/7#comment" };
      },
    } as unknown as GitHubClient;

    const committed = await commitAction(store, client, prepared.id);
    assert.equal(called, 1);
    assert.equal(committed.ok, true);
    assert.equal(store.listAudit(1)[0]?.status, "completed");
    assert.equal(store.getTaskState(task!.id)?.status, "done");
    store.close();
  });
});
