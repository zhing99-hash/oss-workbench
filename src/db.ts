import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync } from "node:fs";
import { ensureAppHome, databasePath } from "./paths.js";
import type {
  AuditRecord,
  IssueRecord,
  PreparedAction,
  PullRecord,
  RepoRecord,
} from "./types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS repos (
  id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  full_name TEXT NOT NULL UNIQUE,
  description TEXT,
  html_url TEXT NOT NULL,
  private INTEGER NOT NULL DEFAULT 0,
  fork INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  language TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  forks INTEGER NOT NULL DEFAULT 0,
  watchers INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  license TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  pushed_at TEXT,
  updated_at TEXT,
  latest_release_tag TEXT,
  latest_release_at TEXT,
  release_downloads INTEGER NOT NULL DEFAULT 0,
  contributors INTEGER NOT NULL DEFAULT 0,
  has_readme INTEGER NOT NULL DEFAULT 0,
  health INTEGER NOT NULL DEFAULT 50,
  synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  repo_id INTEGER NOT NULL,
  repo_full_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  author TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  comments INTEGER NOT NULL DEFAULT 0,
  assignees TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  html_url TEXT NOT NULL,
  draft INTEGER NOT NULL DEFAULT 0,
  mergeable INTEGER,
  ci_status TEXT NOT NULL DEFAULT 'unknown',
  head_sha TEXT,
  requested_reviewers TEXT NOT NULL DEFAULT '[]',
  UNIQUE(repo_id, kind, number),
  FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_items_repo_kind ON items(repo_id, kind, state);
CREATE INDEX IF NOT EXISTS idx_items_updated ON items(updated_at);

CREATE TABLE IF NOT EXISTS contributors (
  repo_id INTEGER NOT NULL,
  login TEXT NOT NULL,
  contributions INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(repo_id, login),
  FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS snapshots (
  day TEXT PRIMARY KEY,
  stars INTEGER NOT NULL,
  forks INTEGER NOT NULL,
  contributors INTEGER NOT NULL,
  open_issues INTEGER NOT NULL,
  open_pulls INTEGER NOT NULL,
  captured_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_states (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  action TEXT NOT NULL,
  repo TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_number INTEGER,
  summary TEXT NOT NULL,
  preview_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  tool TEXT NOT NULL,
  repo TEXT NOT NULL,
  target TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(filename = databasePath()) {
    ensureAppHome();
    this.db = new DatabaseSync(filename);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  setMeta(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(value));
  }

  getMeta<T>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? parseJson<T>(row.value, null as T) : null;
  }

  upsertRepo(repo: RepoRecord): void {
    this.db.prepare(`
      INSERT INTO repos (
        id, owner, name, full_name, description, html_url, private, fork, archived,
        language, stars, forks, watchers, open_issues, license, default_branch,
        pushed_at, updated_at, latest_release_tag, latest_release_at, release_downloads,
        contributors, has_readme, health, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner=excluded.owner, name=excluded.name, full_name=excluded.full_name,
        description=excluded.description, html_url=excluded.html_url, private=excluded.private,
        fork=excluded.fork, archived=excluded.archived, language=excluded.language,
        stars=excluded.stars, forks=excluded.forks, watchers=excluded.watchers,
        open_issues=excluded.open_issues, license=excluded.license,
        default_branch=excluded.default_branch, pushed_at=excluded.pushed_at,
        updated_at=excluded.updated_at, latest_release_tag=excluded.latest_release_tag,
        latest_release_at=excluded.latest_release_at, release_downloads=excluded.release_downloads,
        contributors=excluded.contributors, has_readme=excluded.has_readme,
        health=excluded.health, synced_at=excluded.synced_at
    `).run(
      repo.id, repo.owner, repo.name, repo.fullName, repo.description, repo.htmlUrl,
      repo.private ? 1 : 0, repo.fork ? 1 : 0, repo.archived ? 1 : 0,
      repo.language, repo.stars, repo.forks, repo.watchers, repo.openIssues,
      repo.license, repo.defaultBranch, repo.pushedAt, repo.updatedAt,
      repo.latestReleaseTag, repo.latestReleaseAt, repo.releaseDownloads,
      repo.contributors, repo.hasReadme ? 1 : 0, repo.health, repo.syncedAt,
    );
  }

  removeReposNotIn(ids: number[]): void {
    if (ids.length === 0) {
      this.db.prepare("DELETE FROM repos").run();
      return;
    }
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM repos WHERE id NOT IN (${placeholders})`)
      .run(...(ids as SQLInputValue[]));
  }

  replaceItems(repoId: number, items: Array<IssueRecord | PullRecord>): void {
    this.db.prepare("DELETE FROM items WHERE repo_id = ?").run(repoId);
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO items (
        id, repo_id, repo_full_name, kind, number, title, body, state, author,
        labels, comments, assignees, created_at, updated_at, html_url,
        draft, mergeable, ci_status, head_sha, requested_reviewers
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      const pull = "draft" in item ? item : null;
      insert.run(
        item.id, repoId, item.repoFullName, pull ? "pull" : "issue", item.number,
        item.title, item.body, item.state, item.author, JSON.stringify(item.labels),
        item.comments, JSON.stringify(item.assignees), item.createdAt, item.updatedAt,
        item.htmlUrl, pull?.draft ? 1 : 0,
        pull?.mergeable == null ? null : (pull.mergeable ? 1 : 0),
        pull?.ciStatus ?? "unknown", pull?.headSha ?? null,
        JSON.stringify(pull?.requestedReviewers ?? []),
      );
    }
  }

  replaceContributors(repoId: number, contributors: Array<{ login: string; contributions: number }>): void {
    this.db.prepare("DELETE FROM contributors WHERE repo_id = ?").run(repoId);
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO contributors(repo_id, login, contributions) VALUES (?, ?, ?)",
    );
    for (const contributor of contributors) {
      insert.run(repoId, contributor.login, contributor.contributions);
    }
  }

  listRepos(): RepoRecord[] {
    const rows = this.db.prepare("SELECT * FROM repos ORDER BY stars DESC, updated_at DESC").all() as Record<string, unknown>[];
    return rows.map(mapRepo);
  }

  getRepoByFullName(fullName: string): RepoRecord | null {
    const row = this.db.prepare("SELECT * FROM repos WHERE full_name = ?").get(fullName) as Record<string, unknown> | undefined;
    return row ? mapRepo(row) : null;
  }

  listIssues(): IssueRecord[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE kind='issue' AND state='open' ORDER BY updated_at ASC").all() as Record<string, unknown>[];
    return rows.map(mapIssue);
  }

  listPulls(): PullRecord[] {
    const rows = this.db.prepare("SELECT * FROM items WHERE kind='pull' AND state='open' ORDER BY updated_at ASC").all() as Record<string, unknown>[];
    return rows.map(mapPull);
  }

  openPullCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM items WHERE kind='pull' AND state='open'").get() as { count: number };
    return Number(row.count);
  }

  contributorCount(): number {
    const row = this.db.prepare("SELECT COUNT(DISTINCT login) AS count FROM contributors").get() as { count: number };
    return Number(row.count);
  }

  releaseCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM repos WHERE latest_release_tag IS NOT NULL").get() as { count: number };
    return Number(row.count);
  }

  saveSnapshot(input: {
    stars: number;
    forks: number;
    contributors: number;
    openIssues: number;
    openPulls: number;
  }): void {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    this.db.prepare(`
      INSERT INTO snapshots(day, stars, forks, contributors, open_issues, open_pulls, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        stars=excluded.stars, forks=excluded.forks, contributors=excluded.contributors,
        open_issues=excluded.open_issues, open_pulls=excluded.open_pulls,
        captured_at=excluded.captured_at
    `).run(day, input.stars, input.forks, input.contributors, input.openIssues, input.openPulls, now.toISOString());
  }

  earliestSnapshot(): { day: string; stars: number } | null {
    const row = this.db.prepare("SELECT day, stars FROM snapshots ORDER BY day ASC LIMIT 1").get() as
      | { day: string; stars: number }
      | undefined;
    return row ?? null;
  }

  setTaskState(taskId: string, status: "done" | "snoozed"): void {
    this.db.prepare(`
      INSERT INTO task_states(task_id, status, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at
    `).run(taskId, status, new Date().toISOString());
  }

  getTaskState(taskId: string): { status: string; updatedAt: string } | null {
    const row = this.db.prepare("SELECT status, updated_at FROM task_states WHERE task_id = ?").get(taskId) as
      | { status: string; updated_at: string }
      | undefined;
    return row ? { status: row.status, updatedAt: row.updated_at } : null;
  }

  savePreparedAction(action: PreparedAction, payload: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO pending_actions(
        id, task_id, action, repo, target_type, target_number, summary,
        preview_json, payload_json, status, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(
      action.id, action.taskId, action.action, action.repo, action.targetType,
      action.targetNumber, action.summary, JSON.stringify(action.preview),
      JSON.stringify(payload), new Date().toISOString(), action.expiresAt,
    );
  }

  getPreparedAction(id: string): (PreparedAction & { payload: Record<string, unknown>; status: string; createdAt: string }) | null {
    const row = this.db.prepare("SELECT * FROM pending_actions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      action: String(row.action) as PreparedAction["action"],
      repo: String(row.repo),
      targetType: String(row.target_type) as PreparedAction["targetType"],
      targetNumber: row.target_number == null ? null : Number(row.target_number),
      summary: String(row.summary),
      preview: parseJson(String(row.preview_json), {}),
      payload: parseJson(String(row.payload_json), {}),
      status: String(row.status),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
    };
  }

  markPreparedAction(id: string, status: "completed" | "failed" | "cancelled"): void {
    this.db.prepare("UPDATE pending_actions SET status = ? WHERE id = ?").run(status, id);
  }

  addAudit(record: AuditRecord): void {
    this.db.prepare(`
      INSERT INTO audit(id, created_at, actor, tool, repo, target, summary, status, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.createdAt, record.actor, record.tool, record.repo,
      record.target, record.summary, record.status, record.detail,
    );
  }

  listAudit(limit = 20): AuditRecord[] {
    const rows = this.db.prepare("SELECT * FROM audit ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      createdAt: String(row.created_at),
      actor: String(row.actor),
      tool: String(row.tool),
      repo: String(row.repo),
      target: String(row.target),
      summary: String(row.summary),
      status: String(row.status) as AuditRecord["status"],
      detail: String(row.detail),
    }));
  }

  countOpenIssues(): number {
    return this.listIssues().length;
  }

  hasData(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM repos").get() as { count: number };
    return Number(row.count) > 0;
  }
}

function mapRepo(row: Record<string, unknown>): RepoRecord {
  return {
    id: Number(row.id),
    owner: String(row.owner),
    name: String(row.name),
    fullName: String(row.full_name),
    description: row.description == null ? null : String(row.description),
    htmlUrl: String(row.html_url),
    private: Boolean(row.private),
    fork: Boolean(row.fork),
    archived: Boolean(row.archived),
    language: row.language == null ? null : String(row.language),
    stars: Number(row.stars),
    forks: Number(row.forks),
    watchers: Number(row.watchers),
    openIssues: Number(row.open_issues),
    license: row.license == null ? null : String(row.license),
    defaultBranch: String(row.default_branch),
    pushedAt: row.pushed_at == null ? null : String(row.pushed_at),
    updatedAt: row.updated_at == null ? null : String(row.updated_at),
    latestReleaseTag: row.latest_release_tag == null ? null : String(row.latest_release_tag),
    latestReleaseAt: row.latest_release_at == null ? null : String(row.latest_release_at),
    releaseDownloads: Number(row.release_downloads),
    contributors: Number(row.contributors),
    hasReadme: Boolean(row.has_readme),
    health: Number(row.health),
    syncedAt: String(row.synced_at),
  };
}

function mapIssue(row: Record<string, unknown>): IssueRecord {
  return {
    id: Number(row.id),
    repoId: Number(row.repo_id),
    repoFullName: String(row.repo_full_name),
    number: Number(row.number),
    title: String(row.title),
    body: String(row.body),
    state: String(row.state),
    author: row.author == null ? null : String(row.author),
    labels: parseJson(String(row.labels), []),
    comments: Number(row.comments),
    assignees: parseJson(String(row.assignees), []),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    htmlUrl: String(row.html_url),
  };
}

function mapPull(row: Record<string, unknown>): PullRecord {
  return {
    ...mapIssue(row),
    draft: Boolean(row.draft),
    mergeable: row.mergeable == null ? null : Boolean(row.mergeable),
    ciStatus: String(row.ci_status) as PullRecord["ciStatus"],
    headSha: row.head_sha == null ? null : String(row.head_sha),
    requestedReviewers: parseJson(String(row.requested_reviewers), []),
  };
}

export function databaseExists(): boolean {
  return existsSync(databasePath());
}
