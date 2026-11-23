/**
 * 写操作确认弹窗（M6 剩余项）。
 *
 * 为什么必须弹窗：AGENTS 要求「删除类先隔离 / 每次只处理 1 个文件 / 3 写停」，
 * 人在 UI 上随手点很容易连点或误点。弹窗把「要动哪个文件、什么操作、
 * 策略结论」摆出来让人确认一次，再看一眼策略状态，最后才真正发请求。
 */

import { Modal, Setting } from "obsidian";

export interface ConfirmSpec {
  title: string;
  /** 多行说明：对象、操作、策略结论等 */
  lines: string[];
  /** 按钮上的危险等级 */
  destructive?: boolean;
}

export class ConfirmModal extends Modal {
  private accepted = false;

  constructor(
    app: import("obsidian").App,
    private readonly spec: ConfirmSpec,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.spec.title });
    const pre = contentEl.createEl("pre", { cls: "cloud-netdisk-confirm-body" });
    pre.setText(this.spec.lines.join("\n"));
    contentEl.createDiv({ cls: "cloud-netdisk-confirm-hint", text: "每次只处理 1 个文件/目录；写操作受 3s 间隔 / 60s 冷却 / 3 写停约束。" });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("取消")
          .onClick(() => this.close()),
      )
      .addButton((btn) => {
        btn.setButtonText("确认执行").onClick(() => {
          this.accepted = true;
          this.close();
        });
        if (this.spec.destructive) btn.setWarning();
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.accepted) this.onConfirm();
  }
}
