import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

type TaskPriority = "P0" | "P1" | "P2" | "P3";
type TaskAction =
  | "comment" | "add_labels" | "assign" | "close"
  | "review_comment" | "approve" | "request_changes" | "snooze";

interface WorkItem {
  id: string;
  kind: string;
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
  labels: string[];
  actions: TaskAction[];
}

interface Project {
  fullName: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  stars: number;
  forks: number;
  language: string | null;
  openIssues: number;
  openPullRequests: number;
  health: number;
  healthLabel: "健康" | "需要关注" | "高风险";
  latestReleaseTag: string | null;
  latestReleaseAt: string | null;
  releaseDownloads: number;
  updatedAt: string | null;
}

interface Achievement {
  id: string;
  title: string;
  description: string;
  repo: string | null;
  level: "milestone" | "community" | "quality";
}

interface AuditRecord {
  id: string;
  createdAt: string;
  repo: string;
  target: string;
  summary: string;
  status: "prepared" | "completed" | "failed" | "cancelled";
  detail: string;
}

interface Snapshot {
  configured: boolean;
  account: { login: string; name: string | null; avatarUrl: string } | null;
  syncedAt: string | null;
  generatedAt: string;
  setupMessage?: string;
  stats: {
    repos: number; stars: number; forks: number; contributors: number;
    openIssues: number; openPullRequests: number; releases: number;
    releaseDownloads: number; starDelta: number; firstSnapshotAt: string | null;
  };
  projects: Project[];
  tasks: WorkItem[];
  achievements: Achievement[];
  recentActions: AuditRecord[];
}

interface PreparedAction {
  id: string;
  taskId: string;
  action: TaskAction;
  summary: string;
  preview: Record<string, unknown>;
  repo: string;
  targetType: string;
  targetNumber: number | null;
  expiresAt: string;
}

interface Bridge {
  mode: "mcp" | "browser";
  call: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  openLink?: (url: string) => Promise<void>;
}

const actionNames: Record<TaskAction, string> = {
  comment: "发表评论",
  add_labels: "添加标签",
  assign: "指派负责人",
  close: "关闭并说明",
  review_comment: "提交审查评论",
  approve: "批准 PR",
  request_changes: "请求修改",
  snooze: "稍后处理",
};

const priorityNames: Record<TaskPriority, string> = { P0: "紧急", P1: "优先", P2: "普通", P3: "低优先" };
const root = document.querySelector<HTMLDivElement>("#root")!;
const modalRoot = document.querySelector<HTMLDivElement>("#modal-root")!;
const toastRoot = document.querySelector<HTMLDivElement>("#toast-root")!;

let snapshot: Snapshot | null = null;
let bridge: Bridge | null = null;
let activeTab: "today" | "projects" | "insights" | "audit" = "today";
let activeFilter: "all" | TaskPriority = "all";
let busy = false;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmt(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function relativeTime(value: string | null): string {
  if (!value) return "尚未同步";
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000], ["month", 2_592_000], ["day", 86_400], ["hour", 3_600], ["minute", 60],
  ];
  for (const [unit, amount] of units) {
    if (Math.abs(seconds) >= amount || unit === "minute") return formatter.format(Math.round(seconds / amount), unit);
  }
  return "刚刚";
}

function toast(message: string, error = false): void {
  toastRoot.innerHTML = `<div class="toast ${error ? "error" : ""}">${escapeHtml(message)}</div>`;
  window.setTimeout(() => { toastRoot.innerHTML = ""; }, 4200);
}

async function makeBridge(): Promise<Bridge> {
  if (window.parent === window) {
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      if (name === "workbench_snapshot") {
        const response = await fetch("/api/snapshot", { headers: { Accept: "application/json" } });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "读取失败");
        return { snapshot: await response.json() };
      }
      if (name === "workbench_scan") {
        const response = await fetch("/api/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "扫描失败");
        return await response.json() as Record<string, unknown>;
      }
      if (name === "task_prepare_action") {
        const response = await fetch("/api/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "预览失败");
        return { prepared: await response.json() };
      }
      if (name === "task_commit_action") {
        const response = await fetch("/api/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "执行失败");
        return { committed: await response.json() };
      }
      if (name === "task_cancel_action") {
        const response = await fetch("/api/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
        });
        if (!response.ok) throw new Error((await response.json() as { error?: string }).error || "取消失败");
        return { cancelled: true };
      }
      throw new Error(`浏览器模式不支持工具 ${name}`);
    };
    return { mode: "browser", call };
  }

  const app = new App({ name: "OSS Workbench", version: "0.1.0" }, {});
  await app.connect(new PostMessageTransport(window.parent, window.parent));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await app.callServerTool({ name, arguments: args });
    if (response.isError) {
      const message = response.content?.map((entry) => "text" in entry ? entry.text : "").join("\n") || "工具调用失败";
      throw new Error(message);
    }
    return (response.structuredContent ?? {}) as Record<string, unknown>;
  };
  return {
    mode: "mcp",
    call,
    openLink: async (url: string) => {
      await app.openLink({ url });
    },
  };
}

async function load(initial = false): Promise<void> {
  if (!bridge) bridge = await makeBridge();
  setBusy(true);
  try {
    const result = await bridge.call("workbench_snapshot");
    snapshot = result.snapshot as Snapshot;
    if (initial && snapshot.configured && !snapshot.syncedAt) {
      await scan(false);
      return;
    }
    render();
  } catch (error) {
    renderError((error as Error).message);
  } finally {
    setBusy(false);
  }
}

async function scan(notify = true): Promise<void> {
  if (!bridge || busy) return;
  setBusy(true);
  renderLoadingBanner("正在同步 GitHub 项目并扫描待办…");
  try {
    const result = await bridge.call("workbench_scan", { force: true });
    snapshot = result.snapshot as Snapshot;
    activeTab = "today";
    render();
    if (notify) toast(`扫描完成：${snapshot.tasks.length} 项待处理`);
  } catch (error) {
    toast((error as Error).message, true);
    render();
  } finally {
    setBusy(false);
  }
}

function setBusy(value: boolean): void {
  busy = value;
  const button = document.querySelector<HTMLButtonElement>("#scan-btn");
  if (button) {
    button.disabled = value;
    button.textContent = value ? "正在扫描…" : "立即扫描";
  }
}

function renderLoadingBanner(message: string): void {
  const main = document.querySelector<HTMLElement>(".main");
  if (!main) {
    root.innerHTML = `<div class="boot"><div class="boot-mark">OW</div><p>${escapeHtml(message)}</p><div class="loading-line"></div></div>`;
    return;
  }
  let banner = main.querySelector<HTMLElement>("#loading-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "loading-banner";
    banner.className = "notice";
    main.prepend(banner);
  }
  banner.textContent = message;
}

function render(): void {
  if (!snapshot) return;
  if (!snapshot.configured) {
    renderSetup(snapshot);
    return;
  }
  const taskCount = snapshot.tasks.length;
  const p0 = snapshot.tasks.filter((task) => task.priority === "P0").length;
  const titles = {
    today: ["今日待办", "把需要维护者判断的工作集中到一处"],
    projects: ["开源项目", "授权账号下的项目、活跃度与健康度"],
    insights: ["成果与统计", "开源影响力和项目质量，不把短期流量当历史"],
    audit: ["操作审计", "每一次 AI 建议、人工确认和 GitHub 写操作都有记录"],
  } as const;
  root.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">OW</div>
        <div><div class="brand-title">开源工作台</div><div class="brand-sub">OSS Workbench</div></div>
      </div>
      <div>
        <div class="nav-label">工作区</div>
        <nav class="nav">
          ${navButton("today", "今日待办", String(taskCount), activeTab)}
          ${navButton("projects", "全部项目", String(snapshot.projects.length), activeTab)}
          ${navButton("insights", "成果与统计", "", activeTab)}
          ${navButton("audit", "操作审计", String(snapshot.recentActions.length), activeTab)}
        </nav>
      </div>
      <div class="sidebar-footer">
        ${snapshot.account ? `<div class="account">
          <img class="avatar" src="${escapeHtml(snapshot.account.avatarUrl)}" alt="">
          <div style="min-width:0"><div class="account-name">${escapeHtml(snapshot.account.name || snapshot.account.login)}</div><div class="account-meta">@${escapeHtml(snapshot.account.login)} · 本地数据</div></div>
        </div>` : ""}
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div>
          <div class="eyebrow"><span class="dot"></span>${escapeHtml(relativeTime(snapshot.syncedAt))}同步 · ${bridge?.mode === "mcp" ? "AI 助手内" : "浏览器模式"}</div>
          <h1>${titles[activeTab][0]}</h1>
          <div class="page-sub">${titles[activeTab][1]}</div>
        </div>
        <div class="actions">
          <button class="btn" id="refresh-btn" type="button">刷新数据</button>
          <button class="btn btn-primary" id="scan-btn" type="button" ${busy ? "disabled" : ""}>${busy ? "正在扫描…" : "立即扫描"}</button>
        </div>
      </header>
      ${activeTab === "today" ? renderToday(p0) : ""}
      ${activeTab === "projects" ? renderProjects() : ""}
      ${activeTab === "insights" ? renderInsights() : ""}
      ${activeTab === "audit" ? renderAudit() : ""}
    </main>
  </div>`;
}

function navButton(tab: typeof activeTab, label: string, count: string, active: typeof activeTab): string {
  return `<button class="${tab === active ? "active" : ""}" data-nav="${tab}" type="button">
    <span>${label}</span>${count ? `<span class="nav-count">${escapeHtml(count)}</span>` : ""}
  </button>`;
}

function statsCards(): string {
  if (!snapshot) return "";
  const p0 = snapshot.tasks.filter((task) => task.priority === "P0").length;
  return `<section class="stats">
    <div class="stat"><div class="stat-label"><span>开源项目</span><span>${snapshot.stats.releases} 个有版本</span></div><div class="stat-value">${fmt(snapshot.stats.repos)}</div><div class="stat-delta muted">${snapshot.stats.openIssues} 个开放 Issue</div></div>
    <div class="stat"><div class="stat-label"><span>累计 Stars</span><span>社区认可</span></div><div class="stat-value">${fmt(snapshot.stats.stars)}</div><div class="stat-delta">${snapshot.stats.firstSnapshotAt ? `较首次同步 +${fmt(snapshot.stats.starDelta)}` : "首次快照已记录"}</div></div>
    <div class="stat"><div class="stat-label"><span>已统计贡献者</span><span>活跃仓库</span></div><div class="stat-value">${fmt(snapshot.stats.contributors)}</div><div class="stat-delta muted">按可访问贡献者去重</div></div>
    <div class="stat"><div class="stat-label"><span>需要处理</span><span>${p0 ? `${p0} 项紧急` : "无紧急项"}</span></div><div class="stat-value">${fmt(snapshot.tasks.length)}</div><div class="stat-delta ${p0 ? "" : "muted"}">${snapshot.stats.openPullRequests} 个开放 PR</div></div>
  </section>`;
}

function renderToday(p0: number): string {
  if (!snapshot) return "";
  const visibleTasks = activeFilter === "all" ? snapshot.tasks : snapshot.tasks.filter((task) => task.priority === activeFilter);
  return `${statsCards()}
  <div class="grid">
    <section class="panel">
      <div class="panel-head">
        <div><div class="panel-title">需要处理</div><div class="panel-meta">${p0 ? `${p0} 项紧急，建议优先查看` : "当前没有紧急事项"}</div></div>
        <div class="filters">
          ${filterButton("all", "全部")}
          ${filterButton("P0", "紧急")}
          ${filterButton("P1", "优先")}
          ${filterButton("P2", "普通")}
        </div>
      </div>
      <div class="panel-body">
        ${visibleTasks.length ? visibleTasks.slice(0, 40).map(renderTask).join("") : `<div class="empty"><strong>当前没有待处理事项</strong>可以刷新数据，或稍后再扫描一次。</div>`}
      </div>
    </section>
    <div style="display:grid;gap:14px">
      <section class="panel">
        <div class="panel-head"><div class="panel-title">近期成果</div><span class="panel-meta">${snapshot.achievements.length} 项</span></div>
        <div class="achievements">${snapshot.achievements.slice(0, 5).map(renderAchievement).join("") || `<div class="empty">同步项目后会生成成果里程碑。</div>`}</div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">项目健康度</div><span class="panel-meta">按资料与活跃度估算</span></div>
        <div class="detail-list">
          ${healthRow("健康", snapshot.projects.filter((project) => project.healthLabel === "健康").length)}
          ${healthRow("需要关注", snapshot.projects.filter((project) => project.healthLabel === "需要关注").length)}
          ${healthRow("高风险", snapshot.projects.filter((project) => project.healthLabel === "高风险").length)}
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title">最近操作</div><span class="panel-meta">本机审计</span></div>
        <div>${snapshot.recentActions.slice(0, 3).map(renderAuditRow).join("") || `<div class="empty">还没有执行过操作。</div>`}</div>
      </section>
    </div>
  </div>`;
}

function filterButton(filter: "all" | TaskPriority, label: string): string {
  return `<button class="filter ${activeFilter === filter ? "active" : ""}" data-filter="${filter}" type="button">${label}</button>`;
}

function renderTask(task: WorkItem): string {
  const labels = task.labels.slice(0, 3).map((label) => `<span class="priority priority-p2">${escapeHtml(label)}</span>`).join(" ");
  return `<article class="task">
    <div class="task-top">
      <span class="priority priority-${task.priority.toLowerCase()}">${escapeHtml(priorityNames[task.priority])}</span>
      <div class="task-main">
        <div class="task-title">${escapeHtml(task.title)}<span class="task-repo">${escapeHtml(task.repo)}${task.number ? `#${task.number}` : ""}</span></div>
        <div class="task-reason">${escapeHtml(task.reason)}</div>
        <div class="task-suggestion">${escapeHtml(task.suggestion)}</div>
        <div class="task-actions">
          <button class="btn btn-primary btn-small" data-task="${escapeHtml(task.id)}" type="button">处理</button>
          <a class="btn btn-small" data-external="${escapeHtml(task.url)}" href="${escapeHtml(task.url)}" target="_blank" rel="noopener">打开 GitHub</a>
          ${labels}
        </div>
      </div>
      <span class="task-time">${task.ageHours > 0 ? `${Math.round(task.ageHours)} 小时` : "刚刚"}</span>
    </div>
  </article>`;
}

function renderAchievement(item: Achievement): string {
  const mark = item.level === "milestone" ? "M" : item.level === "community" ? "C" : "Q";
  return `<div class="achievement">
    <div class="achievement-mark">${mark}</div>
    <div><div class="achievement-title">${escapeHtml(item.title)}</div><div class="achievement-desc">${escapeHtml(item.description)}</div></div>
  </div>`;
}

function healthRow(label: string, count: number): string {
  return `<div class="detail-row"><span class="detail-key">${label}</span><span class="detail-val">${count} 个</span></div>`;
}

function renderProjects(): string {
  if (!snapshot) return "";
  return `${statsCards()}
  <section class="panel">
    <div class="panel-head"><div class="panel-title">全部开源项目</div><span class="panel-meta">公开、非 Fork、非归档（可在配置中调整）</span></div>
    <div style="overflow:auto">
      <table class="project-table">
        <thead><tr><th>项目</th><th>健康度</th><th>Stars</th><th>Forks</th><th>Issue</th><th>PR</th><th>最近更新</th></tr></thead>
        <tbody>${snapshot.projects.map(renderProjectRow).join("") || `<tr><td colspan="7"><div class="empty">尚未同步项目。</div></td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

function renderProjectRow(project: Project): string {
  const healthClass = project.healthLabel === "健康" ? "health-good" : project.healthLabel === "需要关注" ? "health-watch" : "health-risk";
  return `<tr>
    <td><div class="project-name" title="${escapeHtml(project.description || project.fullName)}">${escapeHtml(project.fullName)}</div><div class="project-repo">${escapeHtml(project.language || "未标注语言")}${project.latestReleaseTag ? ` · ${escapeHtml(project.latestReleaseTag)}` : ""}</div></td>
    <td><span class="health ${healthClass}">${escapeHtml(project.healthLabel)} ${project.health}</span></td>
    <td class="num">${fmt(project.stars)}</td>
    <td class="num">${fmt(project.forks)}</td>
    <td class="num">${fmt(project.openIssues)}</td>
    <td class="num">${fmt(project.openPullRequests)}</td>
    <td>${escapeHtml(relativeTime(project.updatedAt))}</td>
  </tr>`;
}

function renderInsights(): string {
  if (!snapshot) return "";
  const stars = [...snapshot.projects].sort((a, b) => b.stars - a.stars).slice(0, 6);
  const maxStars = Math.max(1, ...stars.map((project) => project.stars));
  return `${statsCards()}
  <div class="two-col">
    <section class="panel">
      <div class="panel-head"><div class="panel-title">项目影响力</div><span class="panel-meta">按 Stars 排序</span></div>
      <div class="chart">${stars.map((project) => `<div class="bar-row">
        <span class="bar-label" title="${escapeHtml(project.fullName)}">${escapeHtml(project.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Math.round(project.stars / maxStars * 100))}%"></div></div>
        <span class="bar-value">${fmt(project.stars)}</span>
      </div>`).join("") || `<div class="empty">同步项目后显示。</div>`}</div>
    </section>
    <section class="panel">
      <div class="panel-head"><div class="panel-title">累计数据</div><span class="panel-meta">GitHub 当前快照</span></div>
      <div class="detail-list">
        ${[["Stars", snapshot.stats.stars], ["Forks", snapshot.stats.forks], ["开放 Issue", snapshot.stats.openIssues], ["开放 PR", snapshot.stats.openPullRequests], ["Release 下载", snapshot.stats.releaseDownloads]].map(([label, value]) => `<div class="detail-row"><span class="detail-key">${label}</span><span class="detail-val">${fmt(Number(value))}</span></div>`).join("")}
      </div>
    </section>
  </div>
  <section class="panel section">
    <div class="panel-head"><div class="panel-title">成果与里程碑</div><span class="panel-meta">基于当前项目状态</span></div>
    <div class="achievements">${snapshot.achievements.map(renderAchievement).join("") || `<div class="empty">还没有可展示的成果。</div>`}</div>
  </section>
  <section class="panel section">
    <div class="panel-head"><div class="panel-title">数据口径</div><span class="panel-meta">重要说明</span></div>
    <div class="detail-list" style="padding-top:12px">
      <div class="detail-row"><span class="detail-key">Stars / Forks</span><span class="detail-val">GitHub 实时累计值</span></div>
      <div class="detail-row"><span class="detail-key">趋势变化</span><span class="detail-val">自首次同步快照开始记录</span></div>
      <div class="detail-row"><span class="detail-key">贡献者</span><span class="detail-val">活跃项目可访问贡献者去重</span></div>
      <div class="detail-row"><span class="detail-key">流量数据</span><span class="detail-val">受 GitHub API 时间窗口限制，未伪造历史</span></div>
    </div>
  </section>`;
}

function renderAudit(): string {
  if (!snapshot) return "";
  return `<section class="panel">
    <div class="panel-head"><div class="panel-title">本机操作记录</div><span class="panel-meta">${snapshot.recentActions.length} 条最近记录</span></div>
    <div>${snapshot.recentActions.map(renderAuditRow).join("") || `<div class="empty"><strong>还没有操作记录</strong>在待办中点击处理，确认后会记录在这里。</div>`}</div>
  </section>
  <section class="panel section">
    <div class="panel-head"><div class="panel-title">安全边界</div><span class="panel-meta">默认策略</span></div>
    <div class="detail-list" style="padding-top:12px">
      <div class="detail-row"><span class="detail-key">默认能力</span><span class="detail-val">只读扫描与建议</span></div>
      <div class="detail-row"><span class="detail-key">写操作</span><span class="detail-val">必须预览并确认</span></div>
      <div class="detail-row"><span class="detail-key">合并 / 发布</span><span class="detail-val">未开放给自动动作</span></div>
      <div class="detail-row"><span class="detail-key">Token</span><span class="detail-val">只存本机配置或环境变量</span></div>
    </div>
  </section>`;
}

function renderAuditRow(record: AuditRecord): string {
  const statusName = { prepared: "待确认", completed: "已完成", failed: "失败", cancelled: "已取消" }[record.status];
  return `<div class="audit-row">
    <div class="audit-date">${escapeHtml(new Date(record.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }))}</div>
    <div class="audit-main">${escapeHtml(record.summary)}<div class="audit-sub">${escapeHtml(record.repo)}${record.detail && record.status === "failed" ? ` · ${escapeHtml(record.detail)}` : ""}</div></div>
    <span class="status status-${record.status}">${statusName}</span>
  </div>`;
}

function renderSetup(value: Snapshot): void {
  root.innerHTML = `<div class="setup">
    <div class="brand" style="padding:0 0 18px"><div class="brand-mark">OW</div><div><div class="brand-title">开源工作台</div><div class="brand-sub">OSS Workbench</div></div></div>
    <h2>连接你的 GitHub 账号</h2>
    <p>工作台需要读取授权账号下的开源项目，才能扫描待办并展示成果。数据保存在本机，GitHub 仍是项目和代码的事实来源。</p>
    <div class="notice">推荐使用 fine-grained token，只授权目标账号的仓库读取权限；需要处理 Issue 和 PR 时再开启对应写权限。</div>
    <p>在终端执行：</p>
    <pre>export GITHUB_TOKEN=github_pat_xxx
oss-workbench sync
oss-workbench workbench</pre>
    <p>也可以把 Token 保存到本机配置：</p>
    <pre>oss-workbench auth --token github_pat_xxx</pre>
    <button class="btn" id="refresh-btn" type="button">我已配置，重新检查</button>
    ${value.setupMessage ? `<p class="field-help" style="margin-top:16px">${escapeHtml(value.setupMessage)}</p>` : ""}
  </div>`;
}

function renderError(message: string): void {
  root.innerHTML = `<div class="setup">
    <h2>工作台加载失败</h2>
    <p>${escapeHtml(message)}</p>
    <p>如果在 AI 助手中使用，请确认 OSS Workbench MCP 已连接；浏览器模式请确认本地服务仍在运行。</p>
    <button class="btn" id="refresh-btn" type="button">重试</button>
  </div>`;
}

function openTask(taskId: string): void {
  const task = snapshot?.tasks.find((entry) => entry.id === taskId);
  if (!task || !bridge) return;
  const defaultAction = task.targetType === "pull"
    ? (task.actions.includes("review_comment") ? "review_comment" : task.actions[0])
    : (task.actions.includes("comment") ? "comment" : task.actions[0]);
  modalRoot.innerHTML = `<div class="modal-backdrop" data-modal-backdrop="true">
    <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-head">
        <div><div class="modal-title" id="modal-title">处理待办</div><div class="modal-sub">${escapeHtml(task.repo)}${task.number ? `#${task.number}` : ""} · ${escapeHtml(task.title)}</div></div>
        <button class="icon-btn" data-close-modal="true" type="button" aria-label="关闭">×</button>
      </div>
      <div class="modal-body" id="action-form">
        <div class="notice">${escapeHtml(task.reason)}</div>
        <div class="field">
          <label>选择处理方式</label>
          <div class="radio-grid">${task.actions.map((action) => `<label class="radio-card"><input type="radio" name="task-action" value="${action}" ${action === defaultAction ? "checked" : ""}>${actionNames[action]}</label>`).join("")}</div>
        </div>
        <div id="action-fields"></div>
      </div>
      <div class="modal-foot"><button class="btn" data-close-modal="true" type="button">取消</button><button class="btn btn-primary" id="prepare-btn" type="button">生成预览</button></div>
    </section>
  </div>`;
  renderActionFields(task, defaultAction);
  modalRoot.querySelectorAll<HTMLInputElement>('input[name="task-action"]').forEach((input) => {
    input.addEventListener("change", () => renderActionFields(task, input.value as TaskAction));
  });
  modalRoot.querySelector("#prepare-btn")?.addEventListener("click", () => void prepareTask(task));
  modalRoot.querySelector("[data-modal-backdrop]")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeModal();
  });
}

function suggestedComment(task: WorkItem, action: TaskAction): string {
  if (action === "approve") return "改动已检查，未发现阻塞问题。感谢贡献！";
  if (action === "request_changes") return "感谢贡献。请先处理以下问题，再继续审查：\n\n- \n";
  if (action === "review_comment") return "已初步审查这组改动。以下位置建议进一步确认：\n\n- \n";
  if (action === "close") return "该问题已处理或不再需要跟进，因此关闭。若仍有疑问，欢迎继续回复。";
  if (task.kind === "issue_reply") return "感谢反馈。我们已收到这个问题，正在确认复现步骤。\n\n为了更快定位，请补充：\n\n- 使用的版本\n- 操作系统\n- 最小复现步骤\n- 相关错误日志";
  if (task.kind === "issue_stale") return "这个 Issue 已较长时间没有更新。请问问题是否仍然存在？如果仍然需要处理，请补充当前信息和复现步骤；否则我们会在确认后关闭。";
  return "感谢反馈，我们会进一步确认这个问题。";
}

function renderActionFields(task: WorkItem, action: TaskAction): void {
  const container = modalRoot.querySelector<HTMLElement>("#action-fields");
  if (!container) return;
  if (action === "add_labels") {
    const presets = ["bug", "documentation", "enhancement", "question", "good first issue"];
    container.innerHTML = `<div class="field"><label>选择标签</label><div class="radio-grid">${presets.map((label, index) => `<label class="radio-card"><input type="checkbox" name="labels" value="${label}" ${index === 0 ? "checked" : ""}>${label}</label>`).join("")}</div><div class="field-help">只会添加标签，不会移除已有标签。</div></div>`;
    return;
  }
  if (action === "assign") {
    container.innerHTML = `<div class="field"><label>GitHub 用户名</label><input id="assignee-input" value="${escapeHtml(snapshot?.account?.login || "")}" placeholder="例如 octocat"><div class="field-help">多个用户名可用英文逗号分隔。</div></div>`;
    return;
  }
  if (action === "snooze") {
    container.innerHTML = `<div class="notice">该事项会从当前待办中隐藏，但不会修改 GitHub。下次扫描仍会根据项目状态判断。</div>`;
    return;
  }
  const required = ["comment", "review_comment", "approve", "request_changes"].includes(action);
  container.innerHTML = `<div class="field">
    <label>${action === "close" ? "关闭说明（可选）" : "评论 / 审查内容"}</label>
    <textarea id="comment-input" ${required ? "required" : ""}>${escapeHtml(suggestedComment(task, action))}</textarea>
    <div class="field-help">内容会原样提交到 GitHub，请先检查语气和事实。</div>
  </div>`;
}

async function prepareTask(task: WorkItem): Promise<void> {
  if (!bridge) return;
  const selected = modalRoot.querySelector<HTMLInputElement>('input[name="task-action"]:checked')?.value as TaskAction | undefined;
  if (!selected) return;
  const comment = modalRoot.querySelector<HTMLTextAreaElement>("#comment-input")?.value;
  const labels = [...modalRoot.querySelectorAll<HTMLInputElement>('input[name="labels"]:checked')].map((input) => input.value);
  const assigneeRaw = modalRoot.querySelector<HTMLInputElement>("#assignee-input")?.value;
  const assignees = assigneeRaw?.split(",").map((value) => value.trim()).filter(Boolean);
  const button = modalRoot.querySelector<HTMLButtonElement>("#prepare-btn");
  if (button) { button.disabled = true; button.textContent = "正在生成…"; }
  try {
    const response = await bridge.call("task_prepare_action", {
      taskId: task.id,
      action: selected,
      ...(comment !== undefined ? { comment } : {}),
      ...(labels.length ? { labels } : {}),
      ...(assignees?.length ? { assignees } : {}),
    });
    const prepared = response.prepared as PreparedAction;
    showPreview(task, prepared);
  } catch (error) {
    toast((error as Error).message, true);
    if (button) { button.disabled = false; button.textContent = "生成预览"; }
  }
}

function showPreview(task: WorkItem, prepared: PreparedAction): void {
  const previewComment = typeof prepared.preview.comment === "string" ? prepared.preview.comment : "";
  const labels = Array.isArray(prepared.preview.labels) ? prepared.preview.labels.join("、") : "";
  const assignees = Array.isArray(prepared.preview.assignees) ? prepared.preview.assignees.join("、") : "";
  const body = modalRoot.querySelector<HTMLElement>("#action-form");
  if (body) {
    body.innerHTML = `<div class="preview">
      <div class="preview-label">执行预览</div>
      <div class="preview-text">${escapeHtml(prepared.summary)}</div>
      ${previewComment ? `<div class="preview-meta">提交内容</div><div class="preview-text" style="margin-top:4px">${escapeHtml(previewComment)}</div>` : ""}
      ${labels ? `<div class="preview-meta">标签：${escapeHtml(labels)}</div>` : ""}
      ${assignees ? `<div class="preview-meta">负责人：${escapeHtml(assignees)}</div>` : ""}
      <div class="preview-meta">目标：${escapeHtml(task.repo)}${task.number ? `#${task.number}` : ""}</div>
      <div class="preview-meta">预览 10 分钟内有效。</div>
    </div>
    ${task.targetType === "repo" ? "" : `<div class="field-help" style="margin-top:12px">执行后会在 GitHub 上产生真实变更，并写入本机审计记录。</div>`}`;
  }
  const foot = modalRoot.querySelector<HTMLElement>(".modal-foot");
  if (foot) {
    foot.innerHTML = `<button class="btn" id="back-btn" type="button">返回修改</button><button class="btn btn-danger" id="commit-btn" type="button">确认执行</button>`;
    foot.querySelector("#back-btn")?.addEventListener("click", () => openTask(task.id));
    foot.querySelector("#commit-btn")?.addEventListener("click", () => void commitPrepared(prepared));
  }
}

async function commitPrepared(prepared: PreparedAction): Promise<void> {
  if (!bridge) return;
  const button = modalRoot.querySelector<HTMLButtonElement>("#commit-btn");
  if (button) { button.disabled = true; button.textContent = "正在执行…"; }
  try {
    const response = await bridge.call("task_commit_action", { actionId: prepared.id, confirm: true });
    const committed = response.committed as { message?: string };
    closeModal();
    toast(committed?.message || "操作已完成");
    await load();
  } catch (error) {
    toast((error as Error).message, true);
    if (button) { button.disabled = false; button.textContent = "确认执行"; }
  }
}

function closeModal(): void {
  modalRoot.innerHTML = "";
}

async function openExternal(url: string): Promise<void> {
  if (bridge?.openLink) {
    try { await bridge.openLink(url); return; } catch { /* fall through */ }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const nav = target.closest<HTMLElement>("[data-nav]");
  if (nav) {
    activeTab = nav.dataset.nav as typeof activeTab;
    render();
    return;
  }
  const filter = target.closest<HTMLElement>("[data-filter]");
  if (filter) {
    activeFilter = filter.dataset.filter as typeof activeFilter;
    render();
    return;
  }
  if (target.closest("#scan-btn")) {
    void scan();
    return;
  }
  if (target.closest("#refresh-btn")) {
    void load();
    return;
  }
  const task = target.closest<HTMLElement>("[data-task]");
  if (task) {
    openTask(task.dataset.task || "");
    return;
  }
  const external = target.closest<HTMLAnchorElement>("[data-external]");
  if (external) {
    event.preventDefault();
    void openExternal(external.href);
    return;
  }
  if (target.matches("[data-modal-backdrop]") || target.closest("button[data-close-modal]")) {
    closeModal();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalRoot.innerHTML) closeModal();
});

void load(true);
