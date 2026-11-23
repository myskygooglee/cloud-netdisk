/**
 * 侧边栏：115 目录树 + 搜索 + 容量条 + 面包屑（M6）。
 *
 * 设计约束：
 *  - 所有 115 请求都走 `plugin.policy.read()`，与 agent 共用同一条串行限速队列，
 *    不会因为「人在点侧栏、agent 同时在跑」而并发撞风控。
 *  - 目录懒加载：展开才拉子目录，避免一次把几万目录全打出去。
 *  - 本轮只做**只读**交互：浏览 / 搜索 / 查看元数据。写操作留给 agent 与后续版本。
 */

import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import { formatBytes, P115Entry } from "../115/types";
import type Cloud115Plugin from "../main";

export const VIEW_TYPE_115 = "cloud-netdisk-tree";

interface Crumb {
  cid: string;
  name: string;
}

export class TreeView extends ItemView {
  /** 已展开的目录 cid → 子条目容器 */
  private expanded = new Set<string>();
  private crumbs: Crumb[] = [{ cid: "0", name: "根目录" }];
  private query = "";
  private searchResults: P115Entry[] | null = null;
  private quotaText = "";

  constructor(leaf: WorkspaceLeaf, private readonly plugin: Cloud115Plugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_115;
  }

  getDisplayText(): string {
    return "115 网盘";
  }

  getIcon(): string {
    return "cloud";
  }

  async onOpen(): Promise<void> {
    await this.render();
  }

  async onClose(): Promise<void> {
    /* nothing */
  }

  /** 完整重绘（切换目录 / 搜索 / 刷新时调用）。 */
  async render(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cloud-netdisk-view");

    // 跨进程锁：批处理在跑时侧栏也不打 115（AGENTS：禁止并发）
    const lock = this.plugin.crossLock.status();
    if (lock.locked) {
      const warn = root.createDiv({ cls: "cloud-netdisk-locked" });
      warn.createEl("b", { text: "⛔ 115 批处理正在运行" });
      warn.createDiv({ text: lock.detail });
      warn.createDiv({ text: "为避免并发撞风控，插件暂停所有 115 请求。批处理结束后点刷新。" });
      this.iconButton(warn, "refresh-cw", "刷新", () => void this.render());
      return;
    }

    this.renderHeader(root);
    this.renderBreadcrumb(root);
    this.renderQuota(root);

    const body = root.createDiv({ cls: "cloud-netdisk-body" });
    if (this.query) {
      await this.renderSearch(body);
    } else {
      await this.renderLevel(body, this.currentCid(), 0);
    }
  }

  private currentCid(): string {
    return this.crumbs[this.crumbs.length - 1]?.cid ?? "0";
  }

  private renderHeader(root: HTMLElement): void {
    const head = root.createDiv({ cls: "cloud-netdisk-header" });
    head.createEl("h4", { text: "115 网盘" });

    const actions = head.createDiv({ cls: "cloud-netdisk-actions" });
    this.iconButton(actions, "refresh-cw", "刷新", () => void this.render());
    this.iconButton(actions, "chevron-up", "上一级", () => {
      if (this.crumbs.length <= 1) return;
      this.crumbs.pop();
      this.query = "";
      this.searchResults = null;
      void this.render();
    });
    this.iconButton(actions, "home", "根目录", () => {
      this.crumbs = [{ cid: "0", name: "根目录" }];
      this.query = "";
      this.searchResults = null;
      void this.render();
    });

    const searchRow = head.createDiv({ cls: "cloud-netdisk-search" });
    const input = searchRow.createEl("input", {
      type: "search",
      placeholder: "搜索名称（回车）",
      value: this.query,
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter") return;
      const q = input.value.trim();
      this.query = q;
      this.searchResults = null;
      void this.render();
    });

    // 备份按钮：整库打包上传 115（复用 Python 脚本，见 main.runVaultBackup）
    const backupBar = head.createDiv({ cls: "cloud-netdisk-backup-bar" });
    const backupBtn = backupBar.createEl("button", {
      cls: "cloud-netdisk-backup-btn",
      text: this.plugin.isBackupRunning ? "备份中…" : "⬆ 备份到 115",
    });
    backupBtn.setAttribute("title", "把整个库（含 .obsidian 配置）打成 zip 传到 115");
    if (this.plugin.isBackupRunning) backupBtn.setAttribute("disabled", "true");
    backupBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.plugin.runVaultBackup();
    });
    const status = backupBar.createDiv({ cls: "cloud-netdisk-backup-status" });
    status.setText(this.plugin.backupStatusText().split("\n")[0]);
  }

  private iconButton(parent: HTMLElement, icon: string, title: string, onClick: () => void): HTMLElement {
    const btn = parent.createEl("button", { cls: "cloud-netdisk-icon-button" });
    btn.setAttribute("aria-label", title);
    btn.setAttribute("title", title);
    setIcon(btn, icon);
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      onClick();
    });
    return btn;
  }

  private renderBreadcrumb(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "cloud-netdisk-crumbs" });
    this.crumbs.forEach((c, idx) => {
      if (idx > 0) bar.createSpan({ text: " / ", cls: "cloud-netdisk-sep" });
      const a = bar.createEl("a", { text: c.name, cls: "cloud-netdisk-crumb" });
      a.addEventListener("click", () => {
        this.crumbs = this.crumbs.slice(0, idx + 1);
        this.query = "";
        this.searchResults = null;
        void this.render();
      });
    });
  }

  private renderQuota(root: HTMLElement): void {
    const box = root.createDiv({ cls: "cloud-netdisk-quota" });
    if (!this.quotaText) {
      box.setText("容量读取中…");
      void this.loadQuota(box);
      return;
    }
    box.setText(this.quotaText);
  }

  private async loadQuota(box: HTMLElement): Promise<void> {
    try {
      const q = await this.plugin.policy.read(() => this.plugin.auth.getClient().quota());
      const pct = q.total > 0 ? (q.used / q.total) * 100 : 0;
      this.quotaText = `已用 ${formatBytes(q.used)} / ${formatBytes(q.total)}（${pct.toFixed(1)}%）`;
      box.empty();
      box.setText(this.quotaText);
      const bar = box.createDiv({ cls: "cloud-netdisk-bar" });
      const fill = bar.createDiv({ cls: "cloud-netdisk-bar-fill" });
      fill.setAttribute("style", `width:${Math.min(100, pct).toFixed(2)}%`);
    } catch (err) {
      box.setText(`容量读取失败：${(err as Error).message}`);
    }
  }

  private async renderSearch(body: HTMLElement): Promise<void> {
    const tip = body.createDiv({ cls: "cloud-netdisk-tip" });
    tip.setText(`搜索「${this.query}」`);
    if (!this.searchResults) {
      tip.setText(`搜索「${this.query}」中…`);
      try {
        this.searchResults = await this.plugin.policy.read(() =>
          this.plugin.auth.getClient().search(this.query, 0, 100),
        );
      } catch (err) {
        body.createDiv({ text: `搜索失败：${(err as Error).message}` });
        return;
      }
      tip.setText(`搜索「${this.query}」：${this.searchResults.length} 条`);
    }
    if (!this.searchResults.length) {
      body.createDiv({ cls: "cloud-netdisk-empty", text: "没有匹配的条目" });
      return;
    }
    for (const entry of this.searchResults) void this.renderRow(body, entry, 0, false);
  }

  /** 渲染某一层的条目；`depth` 用于缩进。 */
  private async renderLevel(parent: HTMLElement, cid: string, depth: number): Promise<void> {
    const holder = parent.createDiv({ cls: "cloud-netdisk-level" });
    holder.setAttribute("data-cid", cid);
    const loading = holder.createDiv({ cls: "cloud-netdisk-loading", text: "加载中…" });
    let entries: P115Entry[];
    try {
      const res = await this.plugin.policy.read(() => this.plugin.auth.getClient().listDir(cid, 0, 500));
      entries = res.entries;
      loading.remove();
      if (res.total && res.total > entries.length) {
        holder.createDiv({
          cls: "cloud-netdisk-more",
          text: `该目录共 ${res.total} 项，仅显示前 ${entries.length} 项`,
        });
      }
    } catch (err) {
      loading.setText(`读取失败：${(err as Error).message}`);
      return;
    }
    if (!entries.length) {
      holder.createDiv({ cls: "cloud-netdisk-empty", text: "（空目录）" });
      return;
    }
    for (const entry of entries) {
      await this.renderRow(holder, entry, depth, true);
    }
  }

  private async renderRow(parent: HTMLElement, entry: P115Entry, depth: number, _allowExpand: boolean): Promise<void> {
    const row = parent.createDiv({ cls: "cloud-netdisk-row" });
    row.setAttribute("style", `padding-left:${depth * 14}px`);

    const twisty = row.createSpan({ cls: "cloud-netdisk-twisty" });
    const isExpanded = this.expanded.has(entry.id);
    twisty.setText(entry.isDir ? (isExpanded ? "▾" : "▸") : " ");
    const icon = row.createSpan({ cls: "cloud-netdisk-ico", text: entry.isDir ? "📁" : "📄" });
    const label = row.createSpan({ cls: "cloud-netdisk-name", text: entry.name });
    row.createSpan({
      cls: "cloud-netdisk-meta",
      text: entry.isDir ? "" : formatBytes(entry.size),
    });
    if (entry.isDir) icon.setAttribute("title", `cid=${entry.id}`);

    // 文件：点击就地显示元数据（只读）
    if (!entry.isDir) {
      label.addEventListener("click", () => void this.showDetail(parent, entry));
      return;
    }

    // 目录：右侧「进入」按钮下钻；点行其它位置 = 展开/收起
    const enterBtn = row.createEl("button", { cls: "cloud-netdisk-enter", text: "↗" });
    enterBtn.setAttribute("title", "进入此目录");
    enterBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.crumbs.push({ cid: entry.id, name: entry.name });
      this.query = "";
      this.searchResults = null;
      void this.render();
    });

    const children = parent.createDiv({ cls: "cloud-netdisk-children" });
    if (isExpanded) await this.renderLevel(children, entry.id, depth + 1);

    row.addEventListener("click", () => {
      void (async () => {
        if (this.expanded.has(entry.id)) {
          this.expanded.delete(entry.id);
          children.empty();
          twisty.setText("▸");
          return;
        }
        this.expanded.add(entry.id);
        twisty.setText("▾");
        await this.renderLevel(children, entry.id, depth + 1);
      })();
    });
  }

  private async showDetail(parent: HTMLElement, entry: P115Entry): Promise<void> {
    const old = parent.querySelector(".cloud-netdisk-detail");
    old?.remove();
    const box = parent.createDiv({ cls: "cloud-netdisk-detail" });
    box.setText(`${entry.name} · 读取元数据…`);
    try {
      const full = await this.plugin.policy.read(() => this.plugin.auth.getClient().stat(entry.fid ?? entry.id));
      box.empty();
      const lines = [
        `名称：${full?.name ?? entry.name}`,
        `fid：${full?.fid ?? entry.fid ?? "?"}`,
        `所属目录 cid：${full?.pid ?? "?"}`,
        `大小：${formatBytes(full?.size ?? entry.size)}`,
        `sha1：${full?.sha1 ?? "（未返回）"}`,
        `类型：${full?.ico ?? entry.ico ?? "?"}`,
        `修改时间：${full?.mtime ? new Date(full.mtime * 1000).toLocaleString() : "未知"}`,
      ];
      box.createEl("pre", { text: lines.join("\n") });
      const copy = box.createEl("button", { text: "复制 fid" });
      copy.addEventListener("click", (ev) => {
        void (async () => {
          ev.stopPropagation();
          const fid = full?.fid ?? entry.fid ?? "";
          try {
            await navigator.clipboard.writeText(fid);
            new Notice(`已复制 fid：${fid}`);
          } catch {
            new Notice("复制失败");
          }
        })();
      });
    } catch (err) {
      box.setText(`元数据读取失败：${(err as Error).message}`);
    }
  }
}
