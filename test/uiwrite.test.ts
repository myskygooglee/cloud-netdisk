/**
 * 侧栏写操作闸门（M6 剩余项，2026-11-23）。
 *
 * 关键约束：人在 UI 上点写按钮，必须和 agent 通过 MCP 调用走**完全相同**的闸门：
 *   写开关 / 跨进程锁 / preflight（清单时效 + 会话 + 风控 + 熔断）/ policy.write / 审计
 * 否则"随手点几下"就会绕过 AGENTS 限速，反而更容易撞风控。
 */

import { describe, expect, it, vi } from "vitest";
import { beforeEach } from "vitest";

// ConfirmModal 依赖 obsidian 的 Modal/Setting，在下面用 vi.mock 顶掉 UI 层，
// 这里只测 plugin.uiWrite 的闸门行为，不渲染 DOM。
vi.mock("../src/ui/confirmModal", () => ({ ConfirmModal: class {} }));

import Cloud115Plugin from "../src/main";
import { checkPlanFreshness } from "../src/policy/planFresh";

interface Harness {
  thisObj: any;
  calls: Array<{ method: string; args: unknown[] }>;
  audits: any[];
  settings: any;
}

function harness(opts: {
  writeEnabled?: boolean;
  locked?: boolean;
  fresh?: boolean;
  fileApiOk?: boolean;
  hasRisk?: boolean;
  breakerOpen?: boolean;
} = {}): Harness {
  const calls: Harness["calls"] = [];
  const audits: any[] = [];
  const settings = {
    enableWriteTools: opts.writeEnabled ?? false,
    stateDir: "C:\\fresh-plan-dir",
    planMaxAgeHours: 48,
  };
  const client = {
    mkdir: async (...args: unknown[]) => calls.push({ method: "mkdir", args }),
    rename: async (...args: unknown[]) => calls.push({ method: "rename", args }),
    move: async (...args: unknown[]) => calls.push({ method: "move", args }),
    remove: async (...args: unknown[]) => calls.push({ method: "remove", args }),
    listDir: async () => ({ entries: [], hasMore: false }),
  };
  return {
    calls,
    audits,
    settings,
    thisObj: {
      settings,
      audit: { write: (rec: any) => audits.push(rec) },
      crossLock: {
        guard: () =>
          opts.locked
            ? { locked: true, detail: "批处理正在运行：quarantine_115.py (pid 1234)" }
            : { locked: false, detail: "无批处理在跑" },
      },
      auth: {
        getClient: () => client,
        healthCheck: async () => ({
          hasCookie: true,
          fileApiOk: opts.fileApiOk ?? true,
          hasRisk: opts.hasRisk ?? false,
        }),
      },
      policy: {
        isBreakerOpen: opts.breakerOpen ?? false,
        breakerInfo: "test",
        write: async (fn: () => Promise<unknown>) => fn(),
      },
      ensureQuarantineDir: async () => "QUAR_CID",
      refreshTreeView: async () => undefined,
    },
  };
}

// 让 planFresh 永远按 opts.fresh 返回，避免依赖真实文件。
let freshOverride: boolean | null = null;
vi.mock("../src/policy/planFresh", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/policy/planFresh")>();
  return {
    ...orig,
    checkPlanFreshness: (...args: Parameters<typeof checkPlanFreshness>) =>
      freshOverride === null ? orig.checkPlanFreshness(...args) : { fresh: freshOverride, detail: "mocked" },
  };
});

describe("侧栏写操作闸门（uiWrite）", () => {
  beforeEach(() => {
    freshOverride = null;
  });

  it("只读模式下拒绝写入，零 115 调用", async () => {
    const h = harness({ writeEnabled: false });
    await expect(
      Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "mkdir", { pid: "0", name: "x" }),
    ).rejects.toThrow("只读模式");
    expect(h.calls).toHaveLength(0);
  });

  it("跨进程锁持有时拒绝写入，且落审计", async () => {
    freshOverride = true;
    const h = harness({ writeEnabled: true, locked: true });
    await expect(
      Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "mkdir", { pid: "0", name: "x" }),
    ).rejects.toThrow("批处理正在运行");
    expect(h.calls).toHaveLength(0);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].detail).toContain("cross_process_lock");
  });

  it("清单过期时拒绝写入（preflight 闸门）", async () => {
    freshOverride = false;
    const h = harness({ writeEnabled: true });
    await expect(
      Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "mkdir", { pid: "0", name: "x" }),
    ).rejects.toThrow("开工前必查未通过");
    expect(h.calls).toHaveLength(0);
    expect(h.audits[0].detail).toContain("清单过期");
  });

  it("会话失效 / 风控标记 / 熔断 任一命中都拒绝", async () => {
    freshOverride = true;
    for (const opts of [{ fileApiOk: false }, { hasRisk: true }, { breakerOpen: true }]) {
      const h = harness({ writeEnabled: true, ...opts });
      await expect(
        Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "mkdir", { pid: "0", name: "x" }),
      ).rejects.toThrow("开工前必查未通过");
      expect(h.calls).toHaveLength(0);
    }
  });

  it("闸门全绿时写入放行，并使用 policy.write（限速）", async () => {
    freshOverride = true;
    const h = harness({ writeEnabled: true });
    const writeSpy = vi.spyOn(h.thisObj.policy, "write");
    await Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "mkdir", { pid: "0", name: "x" });
    expect(h.calls).toEqual([{ method: "mkdir", args: ["0", "x"] }]);
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(h.audits.some((a) => a.action === "mkdir" && a.result === "ok" && a.detail === "ui")).toBe(true);
  });

  it("删除类：视频走隔离路由，白名单小垃圾走直删", async () => {
    freshOverride = true;
    const h1 = harness({ writeEnabled: true });
    await Cloud115Plugin.prototype.uiWrite.call(h1.thisObj, "quarantine", {
      fid: "f1",
      name: "movie.mp4",
      size: 1000,
    });
    expect(h1.calls[0].method).toBe("move");
    expect(h1.calls[0].args[1]).toBe("QUAR_CID");
    expect(h1.audits[0].detail).toContain("视频文件");

    const h2 = harness({ writeEnabled: true });
    await Cloud115Plugin.prototype.uiWrite.call(h2.thisObj, "delete_small_garbage", {
      fid: "f2",
      name: "a.url",
      size: 10,
    });
    expect(h2.calls[0].method).toBe("remove");
    expect(h2.audits[0].detail).toContain("白名单");
  });

  it("删除类：非白名单类型拒绝直删", async () => {
    freshOverride = true;
    const h = harness({ writeEnabled: true });
    await expect(
      Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "delete_small_garbage", {
        fid: "f3",
        name: "doc.docx",
        size: 10,
      }),
    ).rejects.toThrow("拒绝直接删除");
    expect(h.calls).toHaveLength(0);
  });

  it("写失败也落审计（result=failed）", async () => {
    freshOverride = true;
    const h = harness({ writeEnabled: true });
    h.thisObj.policy.write = async () => {
      throw new Error("115 backend boom");
    };
    await expect(
      Cloud115Plugin.prototype.uiWrite.call(h.thisObj, "rename", { fid: "f", newName: "x" }),
    ).rejects.toThrow("115 backend boom");
    expect(h.audits.some((a) => a.action === "ui:rename" && a.result === "failed")).toBe(true);
  });
});
