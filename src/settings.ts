import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type Obsidian115Plugin from "./main";

export interface Obsidian115Settings {
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
}

export const DEFAULT_SETTINGS: Obsidian115Settings = {
  cookie: "",
  mcpPort: 7300,
  enableMcp: true,
  minReadIntervalMs: 1000,
  minWriteIntervalMs: 3000,
  writeCooldownEvery: 2,
  writeCooldownSeconds: 60,
  maxWritesBeforeConfirm: 3,
  quarantineRootCid: "",
};

export class Obsidian115SettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: Obsidian115Plugin) {
    super(app, plugin);
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
  }
}
