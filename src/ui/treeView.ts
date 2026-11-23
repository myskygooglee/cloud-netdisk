/**
 * 侧边栏：115 目录树（M6 完整版；当前提供最小可用列表）。
 */

import { ItemView, WorkspaceLeaf } from "obsidian";
import type Obsidian115Plugin from "../main";

export const VIEW_TYPE_115 = "obsidian-115-tree";

export class TreeView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: Obsidian115Plugin) {
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

  async render(): Promise<void> {
    const el = this.contentEl;
    el.empty();
    el.createEl("h4", { text: "115 网盘" });

    const health = el.createDiv({ cls: "obsidian-115-health" });
    health.setText("检查会话中…");

    try {
      const state = await this.plugin.auth.healthCheck();
      health.setText(state.fileApiOk ? `✅ ${state.userName ?? "已登录"}` : `❌ ${state.reason ?? "未登录"}`);
      health.toggleClass("is-ok", state.fileApiOk);
      health.toggleClass("is-bad", !state.fileApiOk);
    } catch (err) {
      health.setText(`❌ ${(err as Error).message}`);
    }

    const list = el.createDiv({ cls: "obsidian-115-list" });
    try {
      const client = this.plugin.auth.getClient();
      const res = await this.plugin.policy.read(() => client.listDir(client.rootCid));
      for (const entry of res.entries) {
        const row = list.createDiv({ cls: "obsidian-115-row" });
        row.createSpan({ text: `${entry.isDir ? "📁" : "📄"} ${entry.name}` });
      }
    } catch (err) {
      list.createDiv({ text: `读取失败：${(err as Error).message}` });
    }
  }
}
