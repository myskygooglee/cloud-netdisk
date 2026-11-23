/**
 * Policy 引擎单测 —— 把 AGENTS.md 的硬规则固化成可执行断言。
 *
 * 运行：npm test
 */

import { describe, expect, it, vi } from "vitest";
import { BreakerOpenError, NeedsConfirmationError, PolicyEngine } from "../src/policy/engine";
import { decideDeletionRoute, quarantineDirName } from "../src/policy/quarantine";
import { P115Error, classifyP115Error } from "../src/115/errors";
import { toolSchemas } from "../src/mcp/tools";

function makeEngine(opts: Partial<ConstructorParameters<typeof PolicyEngine>[0]> = {}) {
  let clock = 0;
  const sleeps: number[] = [];
  const engine = new PolicyEngine({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    ...opts,
  });
  return { engine, sleeps, advance: (ms: number) => (clock += ms) };
}

describe("PolicyEngine · 串行与限速", () => {
  it("读操作之间至少间隔 1s", async () => {
    const { engine, sleeps } = makeEngine();
    await engine.read(async () => 1);
    await engine.read(async () => 2);
    expect(sleeps.filter((s) => s > 0).length).toBeGreaterThanOrEqual(1);
  });

  it("请求永不并发（串行执行）", async () => {
    const { engine } = makeEngine();
    let active = 0;
    let maxActive = 0;
    const task = async () => {
      await engine.read(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      });
    };
    await Promise.all([task(), task(), task()]);
    expect(maxActive).toBe(1);
  });
});

describe("PolicyEngine · 写操作计数与确认", () => {
  it("连续 3 次写后拒绝第 4 次，等待人工确认", async () => {
    const { engine } = makeEngine({ writeCooldownEvery: 100 });
    for (let i = 0; i < 3; i++) {
      await engine.write(async () => "ok");
    }
    await expect(engine.write(async () => "should-not-run")).rejects.toBeInstanceOf(NeedsConfirmationError);
    engine.confirmWrites();
    await expect(engine.write(async () => "ok")).resolves.toBe("ok");
  });

  it("每 2 次写后额外冷却 60s", async () => {
    const { engine, sleeps } = makeEngine({ writeCooldownEvery: 2, writeCooldownMs: 60000 });
    await engine.write(async () => 1);
    await engine.write(async () => 2);
    expect(sleeps).toContain(60000);
  });
});

describe("PolicyEngine · 风控熔断", () => {
  it("命中 990001 立即熔断，后续写操作全部拒绝", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.write(async () => {
        throw new P115Error("risk_control", "errno 990001 登录超时");
      }),
    ).rejects.toBeTruthy();
    expect(engine.isBreakerOpen).toBe(true);
    await expect(engine.write(async () => "no")).rejects.toBeInstanceOf(BreakerOpenError);
    await expect(engine.read(async () => "no")).rejects.toBeInstanceOf(BreakerOpenError);
  });

  it("分类器把 429/405/风控/频繁 全部识别为 risk_control", () => {
    for (const s of ["429 Too Many Requests", "errno 405", "990001", "触发风控", "操作频繁"]) {
      expect(classifyP115Error(s)).toBe("risk_control");
    }
    expect(classifyP115Error("<!DOCTYPE html>")).toBe("session_expired");
    expect(classifyP115Error("errno 90008 文件不存在")).toBe("not_found");
  });
});

describe("PolicyEngine · 开工前必查", () => {
  it("任一项不通过则拒绝开工", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.preflight(async () => ({
        sessionOk: true,
        riskOk: true,
        storageOk: true,
        planFresh: false,
      })),
    ).rejects.toBeTruthy();
  });

  it("全部通过则放行", async () => {
    const { engine } = makeEngine();
    await expect(
      engine.preflight(async () => ({
        sessionOk: true,
        riskOk: true,
        storageOk: true,
        planFresh: true,
      })),
    ).resolves.toBeTruthy();
  });

  it("拒绝开工的报错要带出具体 details（2026-11-23 新增）", async () => {
    const { engine } = makeEngine();
    let msg = "";
    try {
      await engine.preflight(async () => ({
        sessionOk: true,
        riskOk: true,
        storageOk: true,
        planFresh: false,
        details: "115_inventory.jsonl 生成于 2026-11-10，已过 313.2h（阈值 48h）",
      }));
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("开工前必查未通过");
    // 只说「清单过期」用户无从下手，必须告诉他是哪个文件、多旧
    expect(msg).toContain("115_inventory.jsonl");
    expect(msg).toContain("313.2h");
  });
});

describe("删除路由策略", () => {
  it("视频与归档必须先隔离", () => {
    expect(decideDeletionRoute("a.mp4", 100).route).toBe("quarantine");
    expect(decideDeletionRoute("a.zip", 100).route).toBe("quarantine");
    expect(decideDeletionRoute("a.mkv", 100).route).toBe("quarantine");
  });

  it("白名单小垃圾可直删", () => {
    expect(decideDeletionRoute("a.url", 100).route).toBe("direct_delete");
    expect(decideDeletionRoute("a.txt", 100).route).toBe("direct_delete");
  });

  it("其它类型一律走隔离 / 拒绝直删", () => {
    expect(decideDeletionRoute("a.docx", 100).route).toBe("refuse");
    expect(decideDeletionRoute("a.exe", 100).route).toBe("refuse");
    expect(decideDeletionRoute("noext", 100).route).toBe("refuse");
  });

  it("隔离目录名按日期生成", () => {
    expect(quarantineDirName(new Date(2026, 10, 20))).toBe("_去重待删_20261120");
  });
});

describe("工具 schema", () => {
  it("写工具不接受数组参数（每次只处理 1 个文件/目录）", () => {
    const schemas = toolSchemas();
    for (const s of schemas) {
      for (const [key, def] of Object.entries(s.inputSchema.properties as Record<string, any>)) {
        expect(def.type).not.toBe("array");
        expect(key).toBe(key.toLowerCase());
      }
    }
  });

  it("不暴露清空回收站类工具", () => {
    const names = toolSchemas().map((s) => s.name);
    expect(names).not.toContain("clear_recycle_bin");
    expect(names).not.toContain("empty_trash");
  });
});
