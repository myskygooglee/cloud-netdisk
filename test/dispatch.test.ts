/**
 * 工具分发单测：只读闸门 + 隔离路由。
 */

import { describe, expect, it } from "vitest";
import { ToolDispatcher } from "../src/mcp/dispatch";

function makeDispatcher(opts: { writeEnabled: boolean }) {
  const calls: string[] = [];
  const fakeClient = {
    rootCid: "0",
    mkdir: async () => {
      calls.push("mkdir");
    },
    rename: async () => {
      calls.push("rename");
    },
    move: async () => {
      calls.push("move");
    },
    remove: async () => {
      calls.push("remove");
    },
    listDir: async () => ({ entries: [], hasMore: false }),
  };
  const policy = {
    read: async (fn: () => Promise<unknown>) => fn(),
    write: async (fn: () => Promise<unknown>) => fn(),
  } as any;
  const auditRecords: Array<Record<string, unknown>> = [];
  const audit = {
    write: (rec: Record<string, unknown>) => {
      auditRecords.push(rec);
      return rec;
    },
  } as any;
  const auth = { getClient: () => fakeClient } as any;
  const dispatcher = new ToolDispatcher({
    auth,
    policy,
    audit,
    ensureQuarantineDir: async () => "999",
    isWriteEnabled: () => opts.writeEnabled,
  });
  return { dispatcher, calls, auditRecords };
}

describe("只读闸门", () => {
  it("只读模式下写工具被拒绝，且不会真的调用 115", async () => {
    const { dispatcher, calls, auditRecords } = makeDispatcher({ writeEnabled: false });
    const res = await dispatcher.call("mkdir", { pid: "0", name: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("只读模式");
    expect(calls).toHaveLength(0);
    // 被闸门拦下的动作也要落审计（2026-11-23 新增：否则账本里看不见尝试）
    expect(auditRecords).toHaveLength(1);
    expect(auditRecords[0].result).toBe("failed");
    expect(String(auditRecords[0].detail)).toContain("read_only_mode");
  });

  it("放开写工具后调用被放行", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("mkdir", { pid: "0", name: "x" });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(["mkdir"]);
  });

  it("未知工具返回错误而不是抛异常", async () => {
    const { dispatcher } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("nope", {});
    expect(res.isError).toBe(true);
  });
});

describe("删除路由的二次闸门", () => {
  it("delete_small_garbage 拒绝视频（要求改走 quarantine）", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("delete_small_garbage", { fid: "1", name: "a.mp4", size: 100 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("delete_small_garbage 允许白名单小文件", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("delete_small_garbage", { fid: "1", name: "a.url", size: 100 });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(["remove"]);
  });

  it("quarantine 拒绝白名单小文件（提示改用 delete_small_garbage）", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("quarantine", { fid: "1", name: "a.url", size: 100 });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("quarantine 移动视频到隔离目录", async () => {
    const { dispatcher, calls } = makeDispatcher({ writeEnabled: true });
    const res = await dispatcher.call("quarantine", { fid: "1", name: "a.mp4", size: 100 });
    expect(res.isError).toBeUndefined();
    expect(calls).toEqual(["move"]);
  });
});
