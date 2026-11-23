/**
 * Obsidian API 的测试替身（`obsidian` 包只有类型，没有运行时入口）。
 */

export async function requestUrl(_opts: unknown): Promise<{ status: number; text: string }> {
  throw new Error("requestUrl 在单测中不可用，请注入假 transport");
}

export class Notice {
  constructor(public message: string) {}
}

export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class ItemView {}
export class WorkspaceLeaf {}
export class App {}
export class Modal {}
export class Component {}
export class TFile {}
export class TFolder {}
export function setIcon(_el: HTMLElement, _name: string): void {
  /* noop in tests */
}
