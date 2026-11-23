/**
 * M5 准备：写链路的**行为**测试（不改行为，只把现有行为钉死）。
 *
 * 覆盖：只读闸门 → 放开后放行 → 隔离路由 → 3 写停 → confirm_writes → 审计落账。
 */

import { describe, expect, it } from "vitest";
import { ToolDispatcher } from "../src/mcp/dispatch";
import { PolicyEngine } from "../src/policy/engine";
import { TOOLS } from "../src/mcp/tools";

interface FakeCall {
  method: string;
  args: any[];
}

function makeDispatcher(opts: { writeEnabled: boolean; maxWrites?: number }) {
  const calls: FakeCall[] = [];
  const audits: any[] = [];
  let clock = 0;
  const fakeClient = {
    rootCid: "0",
    mkdir: async (...args: any[]) => calls.push({ method: "mkdir", args }),
    rename: async (...args: any[]) => calls.push({ method: "rename", args }),
    move: async (...args: any[]) => calls.push({ method: "move", args }),
    remove: async (...args: any[]) => calls.push({ method: "remove", args }),
    listDir: async () => ({ entries: [], hasMore: false }),
    quota: async () => ({ total: 100, used: 40, free: 60 }),
  };
  const policy = new PolicyEngine({
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    writeCooldownEvery: 1000, // 测试里不触发 60s 冷却
    maxWritesBeforeConfirm: opts.maxWrites ?? 3,
  });
  const dispatcher = new ToolDispatcher({
    auth: { getClient: () => fakeClient, healthCheck: async () => ({ hasCookie: true, fileApiOk: true, hasRisk: false }) } as any,
    policy,
    audit: { write: (rec: any) => audits.push(rec) } as any,
    ensureQuarantineDir: async () => "QUAR_CID",
    isWriteEnabled: () => opts.writeEnabled,
  });
  return { dispatcher, calls, audits, policy };
}

describe("M5 · 只读闸门（写工具默认关闭）", () => {
  const writeTools = TOOLS.filter((t) => t.mutating);

  it("存在 6 个写工具，且全部带 mutating 标记", () => {
    expect(writeTools.length).toBeGreaterThanOrEqual(6);
    for (const t of writeTools) expect(t.mutating).toBe(true);
  });

  it("只读模式下所有写工具都被拒绝，且不产生任何 115 调用", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: false });
    for (const t of writeTools) {
      const args: Record<string, any> = {};
      for (const p of t.params) args[p.name] = p.type === "number" ? 1 : "x";
      const res = await dispatcher.call(t.name, args);
      expect(res.isError, `${t.name} 应被只读模式拒绝`).toBe(true);
      expect(res.content[0].text).toContain("只读模式");
    }
    expect(calls).toHaveLength(0);
  });

  it("只读模式下只读工具照常可用", async () => {
    const { dispatcher } = makeDispatcher({ writeEnabled: false });
    const out = await dispatcher.call("quota", {});
    expect(out.isError).toBeUndefined();
  });
});

describe("M5 · 放开后的写链路", () => {
  it("mkdir → rename → move → delete 依次落账", async () => {
    // 这里放宽写次数上限，只验证"链路与落账"，3 写停由下面的用例单独验证
    const { dispatcher, calls, audits } = makeDispatcher({ writeEnabled: true, maxWrites: 10 });
    await dispatcher.call("mkdir", { pid: "0", name: "测试目录" });
    await dispatcher.call("rename", { fid: "1", new_name: "新名.mp4" });
    await dispatcher.call("move", { fid: "1", to_pid: "2" });
    await dispatcher.call("delete_small_garbage", { fid: "3", name: "a.url", size: 10 });
    expect(calls.map((c) => c.method)).toEqual(["mkdir", "rename", "move", "remove"]);
    expect(audits.map((a) => a.action)).toEqual(["mkdir", "rename", "move", "delete_small_garbage"]);
    expect(audits.every((a) => a.result === "ok")).toBe(true);
  });

  it("quarantine 把视频移进隔离目录并记录原因", async () => {
    const { dispatcher, calls, audits } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("quarantine", { fid: "9", name: "movie.mp4", size: 1000 });
    expect(res.isError).toBeUndefined();
    expect(calls[0].method).toBe("move");
    expect(calls[0].args[1]).toBe("QUAR_CID");
    expect(audits[0].action).toBe("quarantine");
    expect(audits[0].detail).toContain("隔离");
    expect(audits[0].size).toBe(1000);
  });

  it("白名单小垃圾可直删，非白名单一律拒绝", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true });
    const okRes = await dispatcher.call("delete_small_garbage", { fid: "1", name: "x.url", size: 1 });
    expect(okRes.isError).toBeUndefined();
    const badRes = await dispatcher.call("delete_small_garbage", { fid: "2", name: "x.exe", size: 1 });
    expect(badRes.isError).toBe(true);
    expect(badRes.content[0].text).toContain("quarantine");
    expect(calls).toHaveLength(1);
  });
});

describe("M5 · 连续 3 次写后停下确认", () => {
  it("第 4 次写被拒绝，confirm_writes 后恢复", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true, maxWrites: 3 });
    for (let i = 0; i < 3; i++) {
      const r = await dispatcher.call("mkdir", { pid: "0", name: `d${i}` });
      expect(r.isError).toBeUndefined();
    }
    const blocked = await dispatcher.call("mkdir", { pid: "0", name: "d3" });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0].text).toMatch(/确认|confirm_writes/);
    expect(calls).toHaveLength(3);

    const confirmed = await dispatcher.call("confirm_writes", {});
    expect(confirmed.isError).toBeUndefined();
    const after = await dispatcher.call("mkdir", { pid: "0", name: "d4" });
    expect(after.isError).toBeUndefined();
    expect(calls).toHaveLength(4);
  });

  it("被策略拒绝的操作不触碰 115，但会落一条 failed 审计", async () => {
    const { dispatcher, calls, audits } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("delete_small_garbage", { fid: "2", name: "x.exe", size: 1 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
    // 2026-11-23 修复：策略拒绝改为抛 PolicyRejectedError，统一走 catch 落审计
    const rejected = audits.filter((a) => a.result === "failed");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].detail).toContain("policy_rejected");
  });
});
