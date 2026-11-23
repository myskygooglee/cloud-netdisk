import { Notice, Plugin } from "obsidian";
import { AuthManager } from "./115/auth";
import { AuditLog } from "./policy/audit";
import { PolicyEngine } from "./policy/engine";
import { ToolDispatcher } from "./mcp/dispatch";
import { McpServerInfo, startMcpServer } from "./mcp/server";
import { DEFAULT_SETTINGS, Obsidian115Settings, Obsidian115SettingTab } from "./settings";
import { TreeView, VIEW_TYPE_115 } from "./ui/treeView";

export default class Obsidian115Plugin extends Plugin {
  settings: Obsidian115Settings = { ...DEFAULT_SETTINGS };
  auth!: AuthManager;
  policy!: PolicyEngine;
  audit!: AuditLog;
  dispatcher!: ToolDispatcher;
  private mcp: McpServerInfo | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.auth = new AuthManager(
      () => this.settings.cookie,
      (c) => {
        this.settings.cookie = c;
        void this.saveSettings();
      },
    );
    this.auth.load();

    this.policy = new PolicyEngine({
      minReadIntervalMs: this.settings.minReadIntervalMs,
      minWriteIntervalMs: this.settings.minWriteIntervalMs,
      writeCooldownEvery: this.settings.writeCooldownEvery,
      writeCooldownMs: this.settings.writeCooldownSeconds * 1000,
      maxWritesBeforeConfirm: this.settings.maxWritesBeforeConfirm,
    });

    // 审计日志写在插件自己的数据目录（vault 内但属插件目录，不污染笔记）
    this.audit = new AuditLog(`${this.manifest.dir}/data`);

    this.dispatcher = new ToolDispatcher({
      auth: this.auth,
      policy: this.policy,
      audit: this.audit,
      ensureQuarantineDir: async (name) => this.ensureQuarantineDir(name),
    });

    this.registerView(VIEW_TYPE_115, (leaf) => new TreeView(leaf, this));
    this.addRibbonIcon("cloud", "115 网盘", () => void this.activateView());
    this.addCommand({
      id: "open-115-tree",
      name: "打开 115 网盘侧栏",
      callback: () => void this.activateView(),
    });
    this.addCommand({
      id: "check-115-session",
      name: "检查 115 会话",
      callback: async () => {
        const state = await this.auth.healthCheck();
        new Notice(state.fileApiOk ? `✅ 115 会话正常（${state.userName ?? "?"}）` : `❌ ${state.reason ?? "会话异常"}`);
      },
    });

    this.addSettingTab(new Obsidian115SettingTab(this.app, this));

    if (this.settings.enableMcp) {
      await this.restartMcp();
    }
  }

  async onunload(): Promise<void> {
    await this.mcp?.close();
    this.mcp = null;
  }

  async loadSettings(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** 设置变更后重建认证状态 */
  restartAuth(): void {
    this.auth.load();
  }

  /** 启动 / 重启 MCP 服务 */
  async restartMcp(): Promise<void> {
    await this.mcp?.close();
    this.mcp = null;
    if (!this.settings.enableMcp) return;
    try {
      this.mcp = await startMcpServer({
        dispatcher: this.dispatcher,
        port: this.settings.mcpPort,
        onLog: (msg) => console.log("[obsidian-115]", msg),
      });
      new Notice(`115 MCP 已启动：${this.mcp.url}`);
    } catch (err) {
      new Notice(`115 MCP 启动失败：${(err as Error).message}`);
    }
  }

  /** 取得（必要时创建）隔离目录，返回其 cid */
  private async ensureQuarantineDir(name: string): Promise<string> {
    const client = this.auth.getClient();
    const rootCid = this.settings.quarantineRootCid || client.rootCid;
    const existing = await this.policy.read(() => client.listDir(rootCid));
    const hit = existing.entries.find((e) => e.isDir && e.name === name);
    if (hit) return hit.id;
    await this.policy.write(() => client.mkdir(rootCid, name));
    const after = await this.policy.read(() => client.listDir(rootCid));
    const created = after.entries.find((e) => e.isDir && e.name === name);
    if (!created) throw new Error(`隔离目录 ${name} 创建后未在远端找到`);
    return created.id;
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_115);
    if (existing.length) {
      await workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_115, active: true });
    await workspace.revealLeaf(leaf);
  }
}
