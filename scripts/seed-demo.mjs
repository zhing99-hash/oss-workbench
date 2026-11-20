import { Store } from "../dist/db.js";

if (!process.env.OSS_WORKBENCH_HOME || !process.env.OSS_WORKBENCH_HOME.includes("demo")) {
  throw new Error("Refusing to seed demo data into the real data directory. Set OSS_WORKBENCH_HOME to a path containing 'demo'.");
}

const store = new Store();
const now = new Date().toISOString();
const days = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const repos = [
  { id: 1, name: "core", fullName: "octo/core", description: "A fast local-first data engine", stars: 12480, forks: 896, license: "MIT", language: "TypeScript", health: 96, readme: true },
  { id: 2, name: "docs", fullName: "octo/docs", description: "Documentation and guides", stars: 286, forks: 54, license: "CC-BY-4.0", language: "MDX", health: 84, readme: true },
  { id: 3, name: "cli", fullName: "octo/cli", description: "Command line tools", stars: 1720, forks: 151, license: "MIT", language: "Rust", health: 72, readme: true },
  { id: 4, name: "legacy-sdk", fullName: "octo/legacy-sdk", description: null, stars: 84, forks: 12, license: null, language: "Go", health: 42, readme: false },
];

for (const [index, repo] of repos.entries()) {
  store.upsertRepo({
    id: repo.id,
    owner: "octo",
    name: repo.name,
    fullName: repo.fullName,
    description: repo.description,
    htmlUrl: `https://github.com/${repo.fullName}`,
    private: false,
    fork: false,
    archived: false,
    language: repo.language,
    stars: repo.stars,
    forks: repo.forks,
    watchers: repo.stars,
    openIssues: 7 + index * 4,
    license: repo.license,
    defaultBranch: "main",
    pushedAt: days(index + 1),
    updatedAt: days(index),
    latestReleaseTag: index === 3 ? null : `v2.${4 - index}.0`,
    latestReleaseAt: index === 3 ? null : days(9 + index),
    releaseDownloads: index === 0 ? 18420 : 530,
    contributors: [72, 14, 26, 3][index],
    hasReadme: repo.readme,
    health: repo.health,
    syncedAt: now,
  });
  store.replaceContributors(repo.id, [
    { login: "octo", contributions: 420 - index * 50 },
    { login: "alice", contributions: 84 - index * 10 },
    { login: "bob", contributions: 42 - index * 5 },
  ]);
}

store.replaceItems(1, [
  {
    id: 1001, repoId: 1, repoFullName: "octo/core", number: 128,
    title: "Fix token refresh race in sync worker", body: "", state: "open",
    author: "alice", labels: ["bug"], comments: 3, assignees: [],
    createdAt: days(3), updatedAt: days(0), htmlUrl: "https://github.com/octo/core/pull/128",
    draft: false, mergeable: true, ciStatus: "failure", headSha: "abc128", requestedReviewers: [],
  },
  {
    id: 1002, repoId: 1, repoFullName: "octo/core", number: 131,
    title: "Add Windows installation example", body: "", state: "open",
    author: "bob", labels: [], comments: 0, assignees: [],
    createdAt: days(2), updatedAt: days(2), htmlUrl: "https://github.com/octo/core/issues/131",
  },
  {
    id: 1003, repoId: 1, repoFullName: "octo/core", number: 117,
    title: "Memory grows after repeated imports", body: "", state: "open",
    author: "carol", labels: ["bug"], comments: 5, assignees: ["octo"],
    createdAt: days(36), updatedAt: days(14), htmlUrl: "https://github.com/octo/core/issues/117",
  },
]);

store.replaceItems(2, [
  {
    id: 2001, repoId: 2, repoFullName: "octo/docs", number: 86,
    title: "安装说明不够清晰", body: "", state: "open",
    author: "dave", labels: ["documentation"], comments: 0, assignees: [],
    createdAt: days(3), updatedAt: days(2), htmlUrl: "https://github.com/octo/docs/issues/86",
  },
]);

store.setMeta("account", { login: "octo", name: "Octo Maintainer", avatarUrl: "https://github.com/identicons/octo.png" });
store.setMeta("lastSyncAt", now);
store.saveSnapshot({ stars: 14570, forks: 1113, contributors: 89, openIssues: 2, openPulls: 1 });
store.setMeta("demo", true);

store.addAudit({
  id: "demo-audit-1",
  createdAt: days(1),
  actor: "octo",
  tool: "task_commit_action",
  repo: "octo/docs",
  target: "docs:issue_triage:79",
  summary: "为 docs#79 添加 documentation 标签",
  status: "completed",
  detail: "用户确认后执行",
});

console.log("Seeded demo data in", process.env.OSS_WORKBENCH_HOME || "~/.oss-workbench");
store.close();
