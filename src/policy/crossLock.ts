/**
 * 跨进程 115 全局锁（插件侧）。
 *
 * 与 `D:\115-MCP-Server\scripts\_shared_115_lock.py` 共用两个文件：
 *
 *   state\115.lock.json             批处理（quarantine_115.py 等）持有的独占锁
 *   state\115.plugin_activity.json  插件每次打 115 前写的「我动了」时间戳
 *
 * 规则（AGENTS 第一节第 2 条：禁止并发）：
 *  - 批处理持锁（心跳 ≤ 90s）⇒ 插件**拒绝一切 115 请求**，只读也不放行；
 *  - 插件每次请求前刷新活动时间戳，批处理启动前会等它静默 60s。
 *
 * 为什么用「心跳 + TTL」而不是操作系统文件锁：
 * 双方都可能崩溃（Electron 崩溃 / Python 被杀），OS 锁在 Windows 上容易留下
 * 无法回收的句柄；心跳 + TTL 能在 90s 内自愈，且两侧实现都在本仓库里可读可测。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

/** 心跳超过这个秒数即视为陈旧（与 Python 侧 STALE_AFTER 一致） */
export const STALE_AFTER_SECONDS = 90;

export interface BatchLockInfo {
  owner?: string;
  pid?: number;
  kind?: string;
  note?: string;
  started?: string;
  heartbeat?: string;
  heartbeat_ts?: number;
}

export interface LockStatus {
  /** 是否有批处理正在持有有效的锁 */
  locked: boolean;
  /** 锁文件是否存在（不论新旧） */
  present: boolean;
  /** 人类可读说明 */
  detail: string;
  /** 原始锁内容 */
  lock?: BatchLockInfo;
}

export interface CrossLockOptions {
  /** 锁目录，默认 `D:\115-MCP-Server\state` */
  dir?: string;
  /** 测试注入的时钟（毫秒） */
  now?: () => number;
}

export const DEFAULT_LOCK_DIR = "D:\\115-MCP-Server\\state";

export class CrossProcessLock {
  private readonly dir: string;
  private readonly now: () => number;

  constructor(opts: CrossLockOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_LOCK_DIR;
    this.now = opts.now ?? (() => Date.now());
  }

  get lockFile(): string {
    return join(this.dir, "115.lock.json");
  }

  /** 插件活动标记（批处理读这个判断「插件是否还在动」） */
  get activityFile(): string {
    return join(this.dir, "115.plugin_activity.json");
  }

  /** 读取并判定批处理锁状态。 */
  status(): LockStatus {
    if (!existsSync(this.lockFile)) {
      return { locked: false, present: false, detail: "无批处理在跑" };
    }
    let lock: BatchLockInfo;
    try {
      lock = JSON.parse(readFileSync(this.lockFile, "utf-8")) as BatchLockInfo;
    } catch {
      return { locked: false, present: true, detail: "锁文件无法解析（按陈旧处理）" };
    }
    const hb = Number(lock.heartbeat_ts ?? 0);
    const ageSec = hb > 0 ? this.now() / 1000 - hb : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(ageSec) || ageSec > STALE_AFTER_SECONDS) {
      return {
        locked: false,
        present: true,
        detail: `锁已陈旧（心跳 ${Number.isFinite(ageSec) ? `${ageSec.toFixed(0)}s 前` : "缺失"}，阈值 ${STALE_AFTER_SECONDS}s）`,
        lock,
      };
    }
    return {
      locked: true,
      present: true,
      detail: `批处理正在运行：${lock.owner ?? "?"} (pid ${lock.pid ?? "?"})，心跳 ${ageSec.toFixed(0)}s 前`,
      lock,
    };
  }

  /**
   * 请求前置检查：有有效锁就抛错（由 dispatcher 转成给 agent 的明确提示）。
   * 无锁时顺手刷新插件活动时间戳。
   */
  guard(): LockStatus {
    const st = this.status();
    if (st.locked) return st;
    this.touch();
    return st;
  }

  /** 刷新「插件刚动了」时间戳（失败不影响主流程）。 */
  touch(): void {
    try {
      mkdirSync(dirname(this.activityFile), { recursive: true });
      writeFileSync(
        this.activityFile,
        JSON.stringify({ ts: Math.floor(this.now() / 1000), iso: new Date(this.now()).toISOString() }),
        "utf-8",
      );
    } catch {
      /* 写不进去也不阻断请求：最坏情况是批处理多等 60s */
    }
  }
}
