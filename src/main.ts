import { Notice, Plugin } from "obsidian";
import { randomBytes } from "crypto";
import { AuthManager } from "./115/auth";
import { AuditLog } from "./policy/audit";
import { PolicyEngine } from "./policy/engine";
import { checkPlanFreshness } from "./policy/planFresh";
import { CrossProcessLock } from "./policy/crossLock";
import { ToolDispatcher } from "./mcp/dispatch";
import { McpServerInfo, startMcpServer } from "./mcp/server";
import { DEFAULT_SETTINGS, Cloud115Settings, Cloud115SettingTab } from "./settings";
import { TreeView, VIEW_TYPE_115 } from "./ui/treeView";
import { AGENT_GUIDE } from "./mcp/guidance";
import { BackupHandle, describeProgress, resolvePath, startVaultBackup } from "./backup/vaultBackup";

/** 剪贴板复制（优先 navigator.clipboard，失败时退回 DOM 复制）。 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = activeDocument.createElement("textarea");
      ta.value = text;
      activeDocument.body.appendChild(ta);
      ta.select();
      activeDocument.execCommand("copy");
      activeDocument.body.removeChild(ta);
      return true;
    } catch {
      return false;
    }
  }
}

export default class Cloud115Plugin extends Plugin {
  settings: Cloud115Settings = { ...DEFAULT_SETTINGS };
  auth!: AuthManager;
  policy!: PolicyEngine;
  audit!: AuditLog;
  dispatcher!: ToolDispatcher;
  crossLock!: CrossProcessLock;
  private mcp: McpServerInfo | null = null;
  /** 正在跑的备份（同一时刻只允许一个） */
  private backup: BackupHandle | null = null;
  private backupStatus = "从未运行";
  private lastBackup: { ok: boolean; message: string; at: number } | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureMcpToken();

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

    // 跨进程 115 锁：与 D:\115-MCP-Server\scripts\_shared_115_lock.py 共用同一对文件
    this.crossLock = new CrossProcessLock({
      dir: this.settings.crossLockDir || undefined,
    });

    this.dispatcher = new ToolDispatcher({
      auth: this.auth,
      policy: this.policy,
      audit: this.audit,
      ensureQuarantineDir: async (name) => this.ensureQuarantineDir(name),
      isWriteEnabled: () => this.settings.enableWriteTools,
      planFresh: () =>
        checkPlanFreshness(this.settings.stateDir, this.settings.planMaxAgeHours),
      crossLock: () => {
        const st = this.crossLock.guard();
        return { locked: st.locked, detail: st.detail };
      },
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

    this.addCommand({
      id: "backup-vault-to-115",
      name: "备份整个库到 115",
      callback: async () => {
        await this.runVaultBackup();
      },
    });

    this.addRibbonIcon("hard-drive-upload", "备份本库到 115", () => {
      void this.runVaultBackup();
    });

    this.addSettingTab(new Cloud115SettingTab(this.app, this));

    if (this.settings.enableMcp) {
      await this.restartMcp();
    }
  }

  onunload(): void {
    void this.mcp?.close();
    this.mcp = null;
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<Cloud115Settings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
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
        token: this.settings.mcpToken,
        onLog: (msg) => console.debug("[cloud-netdisk]", msg),
      });
      new Notice(`115 MCP 已启动：${this.mcp.url}`);
    } catch (err) {
      new Notice(`115 MCP 启动失败：${(err as Error).message}`);
    }
  }

  /** 确保存在一个持久化令牌（重启后不变，Copilot 配置不会失效） */
  private async ensureMcpToken(): Promise<void> {
    if (!this.settings.mcpToken || this.settings.mcpToken.length < 16) {
      this.settings.mcpToken = randomBytes(24).toString("hex");
      await this.saveSettings();
    }
  }

  /** MCP 服务状态描述（设置页展示） */
  mcpStatusText(): string {
    if (!this.settings.enableMcp) return "MCP 服务已关闭";
    if (!this.mcp) return "MCP 服务未运行（可尝试重启 Obsidian 或关闭再开启插件）";
    return `运行中：${this.mcp.url} | 模式：${this.settings.enableWriteTools ? "读写" : "只读"}`;
  }

  /** 生成给 Copilot 用的 MCP 配置 JSON */
  buildMcpConfig(): string {
    if (!this.mcp) return "";
    const config = {
      mcpServers: {
        "cloud-netdisk": {
          url: this.mcp.url,
          headers: {
            "x-115-token": this.settings.mcpToken,
          },
        },
      },
    };
    return JSON.stringify(config, null, 2);
  }

  /** 复制 MCP 配置到剪贴板 */
  async copyMcpConfig(): Promise<boolean> {
    const text = this.buildMcpConfig();
    if (!text) return false;
    return copyToClipboard(text);
  }

  /** 复制 agent 使用指引到剪贴板 */
  async copyAgentGuide(): Promise<boolean> {
    return copyToClipboard(AGENT_GUIDE);
  }

  // ------------------------------------------------------------ 一键备份

  /** 备份状态（设置页 / Notice 展示） */
  backupStatusText(): string {
    const last = this.lastBackup
      ? `上一次：${this.lastBackup.ok ? "成功" : "失败"} @ ${new Date(this.lastBackup.at).toLocaleString()} —— ${this.lastBackup.message}`
      : "上一次：无记录";
    return `当前：${this.backupStatus}\n${last}`;
  }

  get isBackupRunning(): boolean {
    return this.backup !== null;
  }

  /**
   * 一键备份：打包整个 vault → 上传 115 → 校验 sha1 → 整理旧包。
   *
   * 真正的活由 `D:\115-MCP-Server\scripts\vault_backup_115.py` 完成（7-Zip 打包 +
   * p115client 分块上传 + 跨进程锁），插件只负责起进程、显示进度、记录结果。
   */
  async runVaultBackup(): Promise<void> {
    if (this.backup) {
      new Notice("备份正在进行中，请等它跑完。");
      return;
    }
    // 跨进程锁：批处理在跑时不要凑热闹
    const lock = this.crossLock.status();
    if (lock.locked) {
      new Notice(`⛔ 115 批处理正在运行（${lock.detail}），备份已取消。`);
      return;
    }

    const vaultPath = this.getVaultPath();
    if (!vaultPath) {
      new Notice("❌ 无法确定 vault 的本地路径（仅桌面版支持）");
      return;
    }
    const scriptPath = this.settings.backupScriptPath;
    if (!scriptPath) {
      new Notice("❌ 未配置备份脚本路径（设置 → 一键备份到 115）");
      return;
    }

    const vaultName = this.app.vault.getName();
    this.backupStatus = "正在准备…";
    new Notice("开始备份：打包整个库（可能需要几分钟）…", 6000);

    const handle = startVaultBackup(
      {
        vaultPath,
        vaultName,
        scriptPath,
        pythonPath: this.settings.backupPythonPath,
        backupRoot: this.settings.backupRootDir,
        subdirTemplate: this.settings.backupSubdirTemplate,
        keep: this.settings.backupKeep,
        tmpDir: this.settings.backupTmpDir
          ? resolvePath(vaultPath, this.settings.backupTmpDir)
          : "",
        includeSecrets: this.settings.backupIncludeSecrets,
      },
      (p) => {
        this.backupStatus = describeProgress(p);
        // 关键节点弹通知，否则只在状态栏更新
        if (["packed", "upload", "verified", "done", "error"].includes(p.stage)) {
          new Notice(`115 备份：${describeProgress(p)}`, p.stage === "error" ? 12000 : 6000);
        }
      },
    );
    this.backup = handle;

    const code = await handle.done;
    this.backup = null;
    const ok = code === 0;
    this.backupStatus = ok ? "空闲（上次成功）" : `空闲（上次失败，退出码 ${code}）`;
    this.lastBackup = {
      ok,
      message: this.backupStatus,
      at: Date.now(),
    };
    if (!ok) {
      new Notice(`❌ 115 备份失败（退出码 ${code}）。详见开发者控制台。`, 12000);
    }
  }

  /** 取 vault 的本地绝对路径（桌面版才有 FileSystemAdapter）。 */
  private getVaultPath(): string | null {
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (typeof adapter.getBasePath === "function") {
      try {
        return adapter.getBasePath();
      } catch {
        return null;
      }
    }
    return null;
  }

  cancelVaultBackup(): void {
    this.backup?.cancel();
    this.backup = null;
    this.backupStatus = "已取消";
  }

  /** 取得（必要时创建）隔离目录，返回其 cid */
  private async ensureQuarantineDir(name: string): Promise<string> {
    const client = this.auth.getClient();
    const rootCid = this.settings.quarantineRootCid || client.rootCid;
    const existing = await this.policy.read(() => client.listDir(rootCid));
    const hit = existing.entries.find((e) => e.isDir && e.name === name);
    if (hit) return hit.id;
    const created = await this.policy.write(() => client.mkdir(rootCid, name));
    if (created?.cid) return created.cid;
    // 接口没回 cid 时回查一次（隔离目录必须拿到 cid 才能移动文件）
    const after = await this.policy.read(() => client.listDir(rootCid));
    const found = after.entries.find((e) => e.isDir && e.name === name);
    if (!found) throw new Error(`隔离目录 ${name} 创建后未在远端找到`);
    return found.id;
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
