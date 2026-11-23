/**
 * preflight 清单时效（AGENTS 第四节）：mtime 超 48h 必须判定为「清单过期」。
 */

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkPlanFreshness } from "../src/policy/planFresh";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "Cloud115-plan-"));
});

function touch(name: string, ageHours: number) {
  const p = join(dir, name);
  writeFileSync(p, "{}\n");
  const t = (Date.now() - ageHours * 3_600_000) / 1000;
  utimesSync(p, t, t);
  return p;
}

describe("清单时效", () => {
  it("目录不存在 ⇒ 过期", () => {
    const r = checkPlanFreshness(join(dir, "nope"), 48);
    expect(r.fresh).toBe(false);
    expect(r.detail).toContain("不存在");
  });

  it("未配置目录 ⇒ 过期（不默认放行）", () => {
    const r = checkPlanFreshness("   ", 48);
    expect(r.fresh).toBe(false);
  });

  it("优先文件在阈值内 ⇒ 新鲜", () => {
    touch("115_inventory.jsonl", 2);
    const r = checkPlanFreshness(dir, 48);
    expect(r.fresh).toBe(true);
    expect(r.detail).toContain("115_inventory.jsonl");
  });

  it("只有过期文件 ⇒ 过期，并报出已过多少小时", () => {
    touch("dedup2_remaining_verified.jsonl", 72);
    const r = checkPlanFreshness(dir, 48);
    expect(r.fresh).toBe(false);
    expect(r.ageHours).toBeGreaterThan(48);
    expect(r.detail).toContain("已过");
  });

  it("没有优先文件时退化为目录里最新的 .jsonl", () => {
    touch("other_old.jsonl", 200);
    touch("other_new.jsonl", 5);
    const r = checkPlanFreshness(dir, 48);
    expect(r.fresh).toBe(true);
    expect(r.file?.endsWith("other_new.jsonl")).toBe(true);
  });

  it("目录里没有 .jsonl ⇒ 过期", () => {
    expect(checkPlanFreshness(dir, 48).fresh).toBe(false);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
