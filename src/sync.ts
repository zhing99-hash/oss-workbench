import type { GitHubClient, RawIssue, RawPull, RawRepo } from "./github.js";
import { GitHubError, toIssueRecord, toPullRecord, toRepoRecord } from "./github.js";
import type { Store } from "./db.js";
import type { AccountOptions, IssueRecord, PullRecord, RepoRecord } from "./types.js";
import { daysSince, mapLimit } from "./utils.js";

export interface SyncResult {
  account: { login: string; name: string | null; avatarUrl: string };
  repositories: number;
  issues: number;
  pulls: number;
  enrichedRepositories: number;
  warnings: string[];
  durationMs: number;
}

export function healthScore(input: {
  archived: boolean;
  license: string | null;
  description: string | null;
  hasReadme: boolean;
  pushedAt: string | null;
  openIssues: number;
  openPulls: number;
}): number {
  let score = 100;
  if (input.archived) score -= 40;
  if (!input.license) score -= 10;
  if (!input.description) score -= 8;
  if (!input.hasReadme) score -= 10;
  const inactiveDays = daysSince(input.pushedAt);
  if (inactiveDays > 180) score -= 22;
  else if (inactiveDays > 90) score -= 14;
  else if (inactiveDays > 30) score -= 5;
  if (input.openIssues > 100) score -= 10;
  else if (input.openIssues > 50) score -= 6;
  if (input.openPulls > 30) score -= 10;
  else if (input.openPulls > 15) score -= 5;
  return Math.max(0, Math.min(100, score));
}

export function shouldIncludeRepo(repo: RawRepo, options: AccountOptions): boolean {
  if (repo.private && !options.includePrivate) return false;
  if (repo.fork && !options.includeForks) return false;
  if (repo.archived && !options.includeArchived) return false;
  if (options.exclude.some((name) => name.toLowerCase() === repo.full_name.toLowerCase())) return false;
  return true;
}

function repoNameFromUrl(url: string): string | null {
  const match = /\/repos\/([^/]+\/[^/]+)$/.exec(url);
  return match?.[1] ?? null;
}

function pullFromSearchItem(item: RawIssue, repoFullName: string): PullRecord {
  return {
    ...toIssueRecord(item, repoFullName),
    draft: Boolean(item.draft),
    mergeable: null,
    ciStatus: "unknown",
    headSha: null,
    requestedReviewers: [],
  };
}

export async function syncAccount(
  client: GitHubClient,
  store: Store,
  options: AccountOptions,
): Promise<SyncResult> {
  if (!client.configured) {
    throw new GitHubError("GitHub token is not configured. Set GITHUB_TOKEN or run `oss-workbench auth --token <token>`.", 401);
  }

  const started = Date.now();
  const warnings: string[] = [];
  const user = await client.getAuthenticatedUser();
  const repos = (await client.listOwnedRepos(options.includeOrganizations)).filter((repo) => shouldIncludeRepo(repo, options));
  const allowed = new Map(repos.map((repo) => [repo.full_name.toLowerCase(), repo]));

  const scopes = new Map<string, "user" | "org">([[user.login, "user"]]);
  if (options.includeOrganizations) {
    for (const repo of repos) {
      if (repo.owner.login !== user.login && scopes.size < 10) scopes.set(repo.owner.login, "org");
    }
  }

  const rawIssues: RawIssue[] = [];
  const rawPulls: RawIssue[] = [];
  for (const [owner, scope] of scopes) {
    rawIssues.push(...(await client.searchOpenItems(owner, "issue", scope)));
    rawPulls.push(...(await client.searchOpenItems(owner, "pr", scope)));
  }

  const issuesByRepo = new Map<string, IssueRecord[]>();
  for (const item of rawIssues) {
    const repoName = repoNameFromUrl(item.repository_url);
    if (!repoName || !allowed.has(repoName.toLowerCase())) continue;
    const list = issuesByRepo.get(repoName) ?? [];
    list.push(toIssueRecord(item, repoName));
    issuesByRepo.set(repoName, list);
  }

  const pullsByRepo = new Map<string, PullRecord[]>();
  for (const item of rawPulls) {
    const repoName = repoNameFromUrl(item.repository_url);
    if (!repoName || !allowed.has(repoName.toLowerCase())) continue;
    const list = pullsByRepo.get(repoName) ?? [];
    list.push(pullFromSearchItem(item, repoName));
    pullsByRepo.set(repoName, list);
  }

  const openPulls = [...pullsByRepo.values()].flat();
  const pullDetails = await mapLimit(openPulls.slice(0, 30), 5, async (pull) => {
    try {
      const detail = await client.getPull(pull.repoFullName, pull.number);
      if (!detail) return pull;
      const ciStatus = await client.getCiStatus(pull.repoFullName, detail.head.sha);
      return toPullRecord(detail, pull.repoFullName, ciStatus);
    } catch (error) {
      warnings.push(`PR ${pull.repoFullName}#${pull.number}: ${(error as Error).message}`);
      return pull;
    }
  });
  const detailedMap = new Map(detailsKey(pullDetails));
  for (const [repoName, pulls] of pullsByRepo) {
    pullsByRepo.set(repoName, pulls.map((pull) => detailedMap.get(`${pull.repoFullName}#${pull.number}`) ?? pull));
  }

  const enrichLimit = 24;
  const enrichRepos = [...repos]
    .sort((a, b) => Date.parse(b.updated_at ?? "") - Date.parse(a.updated_at ?? ""))
    .slice(0, enrichLimit);
  const enrichIds = new Set(enrichRepos.map((repo) => repo.id));
  let enrichedRepositories = 0;

  const repoRecords = await mapLimit(repos, 4, async (repo): Promise<RepoRecord> => {
    let latestReleaseTag: string | null = null;
    let latestReleaseAt: string | null = null;
    let releaseDownloads = 0;
    let contributors = 0;
    let hasReadme = false;

    if (enrichIds.has(repo.id)) {
      enrichedRepositories += 1;
      try {
        const [release, readme, people] = await Promise.all([
          client.getLatestRelease(repo.full_name),
          client.hasReadme(repo.full_name),
          client.listContributors(repo.full_name),
        ]);
        latestReleaseTag = release?.tag ?? null;
        latestReleaseAt = release?.publishedAt || null;
        releaseDownloads = release?.downloads ?? 0;
        hasReadme = readme;
        contributors = people.length;
        store.replaceContributors(repo.id, people);
      } catch (error) {
        warnings.push(`项目 ${repo.full_name}: ${(error as Error).message}`);
      }
    }

    const openPullsForRepo = pullsByRepo.get(repo.full_name)?.length ?? 0;
    const score = healthScore({
      archived: repo.archived,
      license: repo.license?.spdx_id ?? null,
      description: repo.description,
      hasReadme,
      pushedAt: repo.pushed_at,
      openIssues: repo.open_issues_count,
      openPulls: openPullsForRepo,
    });

    return toRepoRecord(
      repo,
      { latestReleaseTag, latestReleaseAt, releaseDownloads, contributors, hasReadme, health: score },
      new Date().toISOString(),
    );
  });

  const now = new Date().toISOString();
  for (const repo of repoRecords) {
    store.upsertRepo(repo);
    store.replaceItems(repo.id, [
      ...(issuesByRepo.get(repo.fullName) ?? []),
      ...(pullsByRepo.get(repo.fullName) ?? []),
    ]);
  }
  store.removeReposNotIn(repoRecords.map((repo) => repo.id));
  store.setMeta("account", {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
  });
  store.setMeta("lastSyncAt", now);
  store.setMeta("lastSyncDurationMs", Date.now() - started);

  const stars = repoRecords.reduce((sum, repo) => sum + repo.stars, 0);
  const forks = repoRecords.reduce((sum, repo) => sum + repo.forks, 0);
  const releaseDownloads = repoRecords.reduce((sum, repo) => sum + repo.releaseDownloads, 0);
  store.saveSnapshot({
    stars,
    forks,
    contributors: store.contributorCount(),
    openIssues: store.listIssues().length,
    openPulls: store.openPullCount(),
  });

  return {
    account: { login: user.login, name: user.name, avatarUrl: user.avatar_url },
    repositories: repoRecords.length,
    issues: store.listIssues().length,
    pulls: store.openPullCount(),
    enrichedRepositories,
    warnings: warnings.slice(0, 20),
    durationMs: Date.now() - started,
  };
}

function detailsKey(pulls: PullRecord[]): Array<[string, PullRecord]> {
  return pulls.map((pull) => [`${pull.repoFullName}#${pull.number}`, pull]);
}
