import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { QrLogin } from "./115/qrcode";
import { READ_ONLY_BANNER, WRITE_MODE_BANNER } from "./mcp/guidance";
import { CrossProcessLock } from "./policy/crossLock";
import { detectServerPaths, pathExists } from "./util/paths";
import type Cloud115Plugin from "./main";

export interface Cloud115Settings {
  /** 115 Cookie 字符串 */
  cookie: string;
  /** MCP 端口（0 = 自动） */
  mcpPort: number;
  /** 是否启用 MCP 服务端 */
  enableMcp: boolean;
  /** 读请求最小间隔（毫秒） */
  minReadIntervalMs: number;
  /** 写请求最小间隔（毫秒） */
  minWriteIntervalMs: number;
  /** 每 N 次写后冷却（秒） */
  writeCooldownEvery: number;
  /** 冷却时长（秒） */
  writeCooldownSeconds: number;
  /** 连续写操作上限（达到后停下等确认） */
  maxWritesBeforeConfirm: number;
  /** 隔离目录根 cid（空 = 与目标同层时由插件创建） */
  quarantineRootCid: string;
  /** MCP 令牌（持久化，重启后不变，避免 Copilot 配置失效） */
  mcpToken: string;
  /** 是否放开写工具给 agent（默认 false：先只读跑通） */
  enableWriteTools: boolean;
  /** 115 侧 state 目录（用于 preflight 的清单 48h 时效检查，空 = 跳过） */
  stateDir: string;
  /** 清单时效阈值（小时），AGENTS：48 */
  planMaxAgeHours: number;
  /** 跨进程 115 锁目录（与 Python 侧 state 目录相同） */
  crossLockDir: string;
  /** 一键备份：打包上传脚本路径 */
  backupScriptPath: string;
  /** 一键备份：python 解释器（空 = 自动探测 .venv） */
  backupPythonPath: string;
  /** 一键备份：115 上的备份根目录 */
  backupRootDir: string;
  /** 一键备份：子目录模板，{vault} 会被替换成库名 */
  backupSubdirTemplate: string;
  /** 一键备份：保留几个 zip（0 = 不限） */
  backupKeep: number;
  /** 一键备份：是否把 data.json（含凭据）也打进包 */
  backupIncludeSecrets: boolean;
  /** 一键备份：完成后的备份包名（空 = 默认 <VAULT><YYYYMMDD>.zip） */
  backupNameTemplate: string;
  /** 一键备份：本地临时 zip 目录（空 = 用脚本默认的 115-MCP-Server\_tmp） */
  backupTmpDir: string;
  /** 上次探测到的 115-MCP-Server 根目录（仅用于设置页展示） */
  detectedServerRoot?: string;
}

export const DEFAULT_SETTINGS: Cloud115Settings = (() => {
  // Python 侧路径**运行时探测**，不再硬编码盘符
  // （2026-11-23 调试发现：硬编码 D:\115-MCP-Server 在实际机器上整片落空）
  const p = detectServerPaths();
  return {
    cookie: "",
    mcpPort: 7300,
    enableMcp: true,
    minReadIntervalMs: 1000,
    minWriteIntervalMs: 3000,
    writeCooldownEvery: 2,
    writeCooldownSeconds: 60,
    maxWritesBeforeConfirm: 3,
    quarantineRootCid: "",
    mcpToken: "",
    enableWriteTools: false,
    stateDir: p.stateDir,
    planMaxAgeHours: 48,
    crossLockDir: p.lockDir,
    backupScriptPath: p.backupScript,
    backupPythonPath: p.python,
    backupRootDir: "[00]obsidian 备份  2026.11.20",
    backupSubdirTemplate: "{vault} 参考资料",
    backupKeep: 3,
    backupIncludeSecrets: false,
    backupNameTemplate: "",
    backupTmpDir: "",
  };
})();

export class Cloud115SettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: Cloud115Plugin) {
    super(app, plugin);
  }

  /**
   * 扫码登录：生成二维码 → 轮询状态 → 抓 Cookie → 保存 → 健康检查。
   * 全部在设置页内完成，不需要手工粘贴 Cookie。
   */
  private async runQrLogin(box: HTMLElement): Promise<void> {
    box.empty();
    const status = box.createDiv({ cls: "cloud-netdisk-qr-status" });
    status.setText("正在向 115 请求二维码…");
    try {
      const qr = new QrLogin({ app: "web" });
      const session = await qr.start();
      status.setText("正在获取二维码图片…");
      const img = box.createEl("img", { cls: "cloud-netdisk-qr-image" });
      img.setAttribute("alt", "115 登录二维码");
      // 115 的 token 接口只给一个网页链接，图片要单独取（否则 <img> 裂图）
      let dataUri = "";
      try {
        dataUri = await qr.fetchImage(session);
      } catch (err) {
        status.setText(`二维码图片加载失败：${(err as Error).message}（可用下方链接扫码）`);
      }
      if (dataUri) {
        img.setAttribute("src", dataUri);
        status.setText("等待扫码…（约 2 分钟内有效）");
      }
      const link = box.createEl("a", { href: session.scanUrl, text: "在 115 App 中打开此链接" });
      link.setAttribute("target", "_blank");

      for (let i = 0; i < 60; i++) {
        await new Promise((r) => window.setTimeout(r, 2000));
        const st = await qr.status(session);
        if (st.status === "scanned") {
          status.setText("已扫码，请在手机上确认登录…");
        } else if (st.status === "signed_in") {
          const cookie = await qr.finish(session);
          this.plugin.auth.setCookie(cookie);
          await this.plugin.saveSettings();
          status.setText("✅ 登录成功，Cookie 已保存");
          const health = await this.plugin.auth.healthCheck();
          new Notice(
            health.fileApiOk
              ? `✅ 115 登录成功（${health.userName ?? "?"}）`
              : `⚠ 已获取 Cookie，但文件接口仍不通：${health.reason ?? "未知原因"}`,
          );
          return;
        } else if (st.status === "expired" || st.status === "canceled") {
          status.setText("二维码已失效或被取消，请重新生成");
          return;
        }
      }
      status.setText("等待超时，请重新生成二维码");
    } catch (err) {
      status.setText(`扫码失败：${(err as Error).message}`);
      new Notice(`扫码失败：${(err as Error).message}`);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("115 会话").setHeading();

    new Setting(containerEl)
      .setName("Cookie")
      .setDesc("115 Web Cookie（含 UID / CID / SEID / KID / acw_tc）。过期后需重新粘贴或扫码。")
      .addText((text) =>
        text
          .setPlaceholder("UID=...; CID=...; SEID=...; KID=...; acw_tc=...")
          .setValue(this.plugin.settings.cookie)
          .onChange(async (value) => {
            this.plugin.settings.cookie = value.trim();
            await this.plugin.saveSettings();
            this.plugin.restartAuth();
          }),
      );

    new Setting(containerEl)
      .setName("会话健康检查")
      .setDesc("同时探测账号接口与文件接口（文件接口不通通常意味着 acw_tc 过期）。")
      .addButton((btn) =>
        btn.setButtonText("检查").onClick(async () => {
          const state = await this.plugin.auth.healthCheck();
          new Notice(state.fileApiOk ? `✅ 会话正常（${state.userName ?? "?"}）` : `❌ ${state.reason ?? "会话异常"}`);
        }),
      );

    const qrBox = containerEl.createDiv({ cls: "cloud-netdisk-qr" });
    new Setting(containerEl)
      .setName("扫码登录")
      .setDesc("用 115 手机 App 扫一扫即可，插件会自动抓取并保存 Cookie（通道固定为 web，115 App 可直接扫）。")
      .addButton((btn) =>
        btn.setButtonText("生成二维码").onClick(async () => {
          await this.runQrLogin(qrBox);
        }),
      );

    new Setting(containerEl).setName("MCP 服务（给 agent 用）").setHeading();

    new Setting(containerEl)
      .setName("启用 MCP 服务")
      .setDesc("在 127.0.0.1 上启动本地 MCP 服务，供 Copilot 等 agent 连接。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableMcp).onChange(async (value) => {
          this.plugin.settings.enableMcp = value;
          await this.plugin.saveSettings();
          await this.plugin.restartMcp();
        }),
      );

    new Setting(containerEl)
      .setName("端口")
      .setDesc("默认 7300；被占用时自动在 7300–7399 内寻找空闲端口。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.mcpPort)).onChange(async (value) => {
          const n = Number(value);
          if (!Number.isNaN(n)) {
            this.plugin.settings.mcpPort = n;
            await this.plugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("服务状态")
      .setDesc(this.plugin.mcpStatusText())
      .addButton((btn) =>
        btn.setButtonText("复制 MCP 配置").onClick(async () => {
          const ok = await this.plugin.copyMcpConfig();
          new Notice(ok ? "✅ MCP 配置已复制到剪贴板" : "⚠️ MCP 服务未运行，无法复制配置");
        }),
      );

    new Setting(containerEl)
      .setName("令牌")
      .setDesc("持久化保存，重启后不变。复制 MCP 配置时会一并带上。")
      .addText((text) =>
        text.setValue(this.plugin.settings.mcpToken).onChange(async (value) => {
          this.plugin.settings.mcpToken = value.trim();
          await this.plugin.saveSettings();
          await this.plugin.restartMcp();
        }),
      );

    new Setting(containerEl)
      .setName("放开写工具")
      .setDesc("关闭时 agent 只能用只读工具（list_dir / stat / search / quota / health）。建议先只读跑通再放开。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableWriteTools).onChange(async (value) => {
          this.plugin.settings.enableWriteTools = value;
          await this.plugin.saveSettings();
          new Notice(value ? "⚠️ 写工具已放开（仍受 AGENTS 策略约束）" : "已切换为只读模式");
        }),
      );

    // ------------------------------------------------ 一键备份到 115
    new Setting(containerEl).setName("一键备份到 115").setHeading();

    new Setting(containerEl)
      .setName("立即备份整个库")
      .setDesc(
        "打包整个 vault（含 .obsidian 插件配置）→ 上传到 115 的备份目录 → 校验 sha1 → 按保留数整理旧包。" +
          "压缩由 7-Zip 完成，上传复用 115-MCP-Server 的分块上传逻辑。",
      )
      .addButton((btn) =>
        btn
          .setButtonText("开始备份")
          .setCta()
          .onClick(async () => {
            await this.plugin.runVaultBackup();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText("状态").onClick(() => {
          new Notice(this.plugin.backupStatusText());
        }),
      );

    new Setting(containerEl)
      .setName("备份脚本路径")
      .setDesc("vault_backup_115.py 的绝对路径。改脚本后无需重启插件。")
      .addText((text) =>
        text
          .setPlaceholder("D:\\115-MCP-Server\\scripts\\vault_backup_115.py")
          .setValue(this.plugin.settings.backupScriptPath)
          .onChange(async (v) => {
            this.plugin.settings.backupScriptPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Python 解释器")
      .setDesc("留空则自动探测脚本同级 .venv / D:\\115-MCP-Server\\.venv。")
      .addText((text) =>
        text
          .setPlaceholder("D:\\115-MCP-Server\\.venv\\Scripts\\python.exe")
          .setValue(this.plugin.settings.backupPythonPath)
          .onChange(async (v) => {
            this.plugin.settings.backupPythonPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("115 备份根目录")
      .setDesc("必须已存在（不会自动创建，避免路径写错时凭空造目录树）。")
      .addText((text) =>
        text
          .setPlaceholder("[00]obsidian 备份  2026.11.20")
          .setValue(this.plugin.settings.backupRootDir)
          .onChange(async (v) => {
            this.plugin.settings.backupRootDir = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("子目录模板")
      .setDesc("`{vault}` 会替换成库名。默认 `<库名> 参考资料`，即 `Books` → `obsidian备份/Books 参考资料`。")
      .addText((text) =>
        text
          .setPlaceholder("{vault} 参考资料")
          .setValue(this.plugin.settings.backupSubdirTemplate)
          .onChange(async (v) => {
            this.plugin.settings.backupSubdirTemplate = v.trim() || "{vault} 参考资料";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("保留备份个数")
      .setDesc("超出的旧包会移到同级的 `_过期备份/`（不直接删除）。0 = 不限。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.backupKeep)).onChange(async (v) => {
          this.plugin.settings.backupKeep = Math.max(0, Number(v) || 0);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("备份包里包含插件凭据")
      .setDesc(
        "⚠️ 默认关闭。打开后 `.obsidian/plugins/*/data.json`（含 115 Cookie、API key）会被打进 zip 并上传。" +
          "你的 VAULT-BACKUP-SPEC 第 10 节要求「永远不要上 115」，一般不要开。",
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.backupIncludeSecrets).onChange(async (v) => {
          this.plugin.settings.backupIncludeSecrets = v;
          await this.plugin.saveSettings();
          if (v) new Notice("⚠️ 备份包将包含 115 Cookie 与 API key，请确认你接受这个风险");
        }),
      );

    // ------------------------------------------------ 使用指引（引导文案）
    const guideBox = containerEl.createDiv({ cls: "cloud-netdisk-guide" });
    guideBox.createEl("h4", { cls: "cloud-netdisk-guide-title", text: "使用指引" });
    const guideText = guideBox.createDiv({ cls: "cloud-netdisk-guide-text" });
    guideText.setText(this.plugin.settings.enableWriteTools ? WRITE_MODE_BANNER : READ_ONLY_BANNER);
    new Setting(containerEl)
      .setName("复制 agent 使用指引")
      .setDesc("把这段说明贴给 Copilot / 其它 agent，让它知道工具边界与红线。")
      .addButton((btn) =>
        btn.setButtonText("复制").onClick(async () => {
          const ok = await this.plugin.copyAgentGuide();
          new Notice(ok ? "✅ 使用指引已复制" : "⚠️ 复制失败");
        }),
      );

    new Setting(containerEl).setName("策略（对应 AGENTS.md 硬规则）").setHeading();

    new Setting(containerEl)
      .setName("读请求最小间隔（毫秒）")
      .setDesc("AGENTS 要求 ≥ 1000ms")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.minReadIntervalMs)).onChange(async (v) => {
          this.plugin.settings.minReadIntervalMs = Math.max(1000, Number(v) || 1000);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("写请求最小间隔（毫秒）")
      .setDesc("AGENTS 要求 ≥ 3000ms")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.minWriteIntervalMs)).onChange(async (v) => {
          this.plugin.settings.minWriteIntervalMs = Math.max(3000, Number(v) || 3000);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("连续写操作上限")
      .setDesc("达到该次数后停下，等待人工确认（AGENTS：3）")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.maxWritesBeforeConfirm)).onChange(async (v) => {
          this.plugin.settings.maxWritesBeforeConfirm = Math.max(1, Number(v) || 3);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("清单目录（preflight 48h 时效检查）")
      .setDesc("AGENTS 要求开工前确认计划文件生成于 48 小时内。填 115-MCP-Server 的 state 目录；留空则按「无清单」拒绝开工。")
      .addText((text) =>
        text
          .setPlaceholder("D:\\115-MCP-Server\\state\\inventory_full_20261123")
          .setValue(this.plugin.settings.stateDir)
          .onChange(async (v) => {
            this.plugin.settings.stateDir = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("清单时效阈值（小时）")
      .setDesc("AGENTS 规定 48 小时，不要放大。")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.planMaxAgeHours)).onChange(async (v) => {
          this.plugin.settings.planMaxAgeHours = Math.max(1, Number(v) || 48);
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("风控熔断状态")
      .setDesc(
        this.plugin.policy.isBreakerOpen
          ? `⛔ 已熔断：${this.plugin.policy.breakerInfo}`
          : "正常（未熔断）",
      )
      .addButton((btn) =>
        btn
          .setButtonText("重置熔断")
          .setWarning()
          .onClick(async () => {
            this.plugin.policy.reset();
            new Notice("已重置熔断与写计数；请先确认会话已恢复再继续。");
            this.display();
          }),
      );

    new Setting(containerEl).setName("跨进程互斥（与 Python 批处理）").setHeading();

    // ------------------------------------------------ 路径自检
    new Setting(containerEl).setName("路径自检").setHeading();

    const detected = detectServerPaths();
    const rows: Array<[string, string]> = [
      ["115-MCP-Server 根目录", detected.root || "（未探测到，请设环境变量 P115_MCP_SERVER_HOME）"],
      ["跨进程锁目录", this.plugin.settings.crossLockDir],
      ["清单目录", this.plugin.settings.stateDir],
      ["备份脚本", this.plugin.settings.backupScriptPath],
      ["Python 解释器", this.plugin.settings.backupPythonPath || detected.python],
    ];
    for (const [label, p] of rows) {
      const okp = pathExists(p);
      new Setting(containerEl)
        .setName(label)
        .setDesc(okp ? `✅ ${p}` : `❌ 路径不存在：${p || "（空）"}`);
    }
    new Setting(containerEl)
      .setName("按探测结果重填路径")
      .setDesc("把上面 4 个路径一次性改成当前机器上真实存在的路径（探测不到就保持原值）。")
      .addButton((btn) =>
        btn
          .setButtonText("重填")
          .setWarning()
          .onClick(async () => {
            if (!detected.root) {
              new Notice("❌ 未探测到 115-MCP-Server，请手动填写各路径");
              return;
            }
            this.plugin.settings.crossLockDir = detected.lockDir;
            this.plugin.settings.stateDir = detected.stateDir;
            this.plugin.settings.backupScriptPath = detected.backupScript;
            this.plugin.settings.backupPythonPath = detected.python;
            await this.plugin.saveSettings();
            this.plugin.crossLock = new CrossProcessLock({
              dir: this.plugin.settings.crossLockDir || undefined,
            });
            new Notice("✅ 已按探测结果重填路径");
            this.display();
          }),
      );

    const lockStatus = this.plugin.crossLock.status();
    new Setting(containerEl)
      .setName("115 全局锁状态")
      .setDesc(
        lockStatus.locked
          ? `⛔ ${lockStatus.detail} — 插件此时会拒绝所有 115 请求（AGENTS：禁止并发）`
          : `✅ ${lockStatus.detail}`,
      )
      .addButton((btn) =>
        btn.setButtonText("刷新").onClick(() => this.display()),
      );

    new Setting(containerEl)
      .setName("锁目录")
      .setDesc(
        "必须与 115-MCP-Server 的 state 目录一致（默认 D:\\115-MCP-Server\\state）。" +
          "两边共用 115.lock.json（批处理独占锁）与 115.plugin_activity.json（插件活动标记）。",
      )
      .addText((text) =>
        text
          .setPlaceholder("D:\\115-MCP-Server\\state")
          .setValue(this.plugin.settings.crossLockDir)
          .onChange(async (v) => {
            this.plugin.settings.crossLockDir = v.trim();
            await this.plugin.saveSettings();
            this.plugin.crossLock = new CrossProcessLock({
              dir: this.plugin.settings.crossLockDir || undefined,
            });
          }),
      );
  }
}
