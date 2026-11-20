import { readFileSync } from "node:fs";
import { readConfig, resolveToken, publicConfig } from "./config.js";
import { Store } from "./db.js";
import { GitHubClient } from "./github.js";
import { buildSnapshot, summarizeSnapshot } from "./scan.js";
import { syncAccount, type SyncResult } from "./sync.js";
import type { AppConfig, WorkbenchSnapshot } from "./types.js";
import { builtWorkbenchHtml } from "./paths.js";

export interface AccountMeta {
  login: string;
  name: string | null;
  avatarUrl: string;
}

export class WorkbenchApp {
  readonly config: AppConfig;
  readonly store: Store;
  readonly client: GitHubClient;

  constructor(options?: { config?: AppConfig; store?: Store; client?: GitHubClient }) {
    this.config = options?.config ?? readConfig();
    this.store = options?.store ?? new Store();
    this.client = options?.client ?? new GitHubClient({
      token: resolveToken(this.config),
      apiBaseUrl: this.config.github.apiBaseUrl,
    });
  }

  get configured(): boolean {
    return this.client.configured;
  }

  account(): AccountMeta | null {
    return this.store.getMeta<AccountMeta>("account");
  }

  lastSyncAt(): string | null {
    return this.store.getMeta<string>("lastSyncAt");
  }

  needsSync(force = false): boolean {
    if (force || !this.store.hasData()) return true;
    const last = this.lastSyncAt();
    if (!last) return true;
    return Date.now() - Date.parse(last) > this.config.workbench.syncMinutes * 60_000;
  }

  async sync(force = true): Promise<SyncResult> {
    if (!this.configured) throw new Error(this.setupMessage());
    return syncAccount(this.client, this.store, this.config.account);
  }

  async ensureSynced(): Promise<void> {
    if (this.configured && this.needsSync()) {
      await this.sync(false);
    }
  }

  snapshot(): WorkbenchSnapshot {
    const account = this.account();
    return buildSnapshot(this.store, {
      configured: this.configured,
      account,
      ...(this.configured ? {} : { setupMessage: this.setupMessage() }),
    });
  }

  summary(): Record<string, unknown> {
    return summarizeSnapshot(this.snapshot());
  }

  setupMessage(): string {
    return [
      "尚未配置 GitHub Token。",
      "请设置环境变量 GITHUB_TOKEN，或在终端运行：",
      "oss-workbench auth --token <your_token>",
      "Token 只需要 repo 读取权限；执行处理动作时还需要 Issues 和 Pull requests 写权限。",
    ].join("\n");
  }

  workbenchHtml(): string {
    try {
      return readFileSync(builtWorkbenchHtml(), "utf8");
    } catch {
      return "<!doctype html><html><body><h1>OSS Workbench</h1><p>Workbench UI is not built yet. Run <code>npm run build</code>.</p></body></html>";
    }
  }

  configView(): Record<string, unknown> {
    return publicConfig(this.config);
  }

  close(): void {
    this.store.close();
  }
}
