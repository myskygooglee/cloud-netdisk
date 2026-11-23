/**
 * 跨进程 115 锁（插件侧）单测：与 Python 的 _shared_115_lock.py 共用同一对文件。
 *
 * 关键断言：批处理持锁 ⇒ 插件必须拒绝一切 115 请求；心跳过期 ⇒ 自动视为无锁。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CrossProcessLock, STALE_AFTER_SECONDS } from "../src/policy/crossLock";

let dir = "";
const FIXED_NOW = 1_800_000_000_000; // 毫秒

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "Cloud115-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function lock(now: number, heartbeatAgeSec: number) {
  const hb = now / 1000 - heartbeatAgeSec;
  writeFileSync(
    join(dir, "115.lock.json"),
    JSON.stringify({
      owner: "quarantine_115.py",
      pid: process.pid,
      kind: "batch",
      note: "tiers=nonvideo",
      heartbeat_ts: hb,
      heartbeat: new Date(hb * 1000).toISOString(),
    }),
    "utf-8",
  );
}

const mk = (now = FIXED_NOW) => new CrossProcessLock({ dir, now: () => now });

describe("跨进程锁：批处理侧", () => {
  it("没有锁文件 ⇒ 未锁、且不误报", () => {
    const st = mk().status();
    expect(st.locked).toBe(false);
    expect(st.present).toBe(false);
  });

  it("心跳新鲜 ⇒ locked=true，并描述 owner/pid", () => {
    lock(FIXED_NOW, 5);
    const st = mk().status();
    expect(st.locked).toBe(true);
    expect(st.detail).toContain("quarantine_115.py");
    expect(st.detail).toContain(String(process.pid));
  });

  it(`心跳超过 ${STALE_AFTER_SECONDS}s ⇒ 视为陈旧，插件可继续工作`, () => {
    lock(FIXED_NOW, STALE_AFTER_SECONDS + 10);
    const st = mk().status();
    expect(st.locked).toBe(false);
    expect(st.present).toBe(true);
    expect(st.detail).toContain("陈旧");
  });

  it("锁文件损坏 ⇒ 按陈旧处理，不崩", () => {
    writeFileSync(join(dir, "115.lock.json"), "{not json", "utf-8");
    const st = mk().status();
    expect(st.locked).toBe(false);
    expect(st.detail).toContain("无法解析");
  });
});

describe("跨进程锁：插件侧", () => {
  it("无锁时 guard() 会刷新插件活动时间戳（批处理据此等待）", () => {
    const l = mk();
    l.guard();
    const st = l.status();
    expect(st.locked).toBe(false);
    // activity 文件应已写出，且 ts 是秒级
    const raw = require("fs").readFileSync(l.activityFile, "utf-8");
    expect(JSON.parse(raw).ts).toBe(FIXED_NOW / 1000);
  });

  it("有锁时 guard() 返回 locked=true（dispatcher 据此拒绝请求）", () => {
    lock(FIXED_NOW, 1);
    expect(mk().guard().locked).toBe(true);
  });

  it("锁目录不存在时 touch 不抛异常（只读盘也不影响主流程）", () => {
    const l = new CrossProcessLock({ dir: join(dir, "not-exists", "deep"), now: () => FIXED_NOW });
    expect(() => l.touch()).not.toThrow();
  });
});
