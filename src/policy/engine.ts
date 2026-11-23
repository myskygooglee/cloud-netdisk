/**
 * Policy 引擎 —— 把 `AGENTS.md` 的 115 硬规则变成可执行、可单测的代码。
 *
 * 规则对照（见 D:\Books\AGENTS.md）：
 *  1. 禁止批量：每次只处理 1 个文件或目录          → 工具 schema 层限制（见 mcp/tools.ts）
 *  2. 禁止并发：必须等上一个调用完全返回再发起下一个 → 本文件的串行队列
 *  3. 连续 3 次写操作后必须停下报告                → writeCount / maxWritesBeforeConfirm
 *  4. 命中风控立即全停                              → breaker（熔断后只允许读）
 *  5. 写前 sleep ≥ 3s；每 2 次写额外等 60s         → writeCooldownEvery / writeCooldownMs
 *  6. 视频 / 归档一律先隔离，不直接删                → policy/quarantine.ts
 *  7. 禁止无人确认时清空回收站                       → tools 层不暴露该端点
 *  8. 开工前必查（会话/风控/容量/清单 48h）          → preflight()
 */

import { P115Error, toP115Error } from "../115/errors";

export class NeedsConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NeedsConfirmationError";
  }
}

export class BreakerOpenError extends Error {
  constructor(public readonly raw: string) {
    super("115 熔断已打开：检测到风控信号，已停止所有 115 操作。");
    this.name = "BreakerOpenError";
  }
}

export interface PolicyOptions {
  /** 读请求最小间隔（秒），AGENTS：≥ 1 */
  minReadIntervalMs?: number;
  /** 写请求最小间隔（秒），AGENTS：≥ 3 */
  minWriteIntervalMs?: number;
  /** 每 N 次写操作后额外冷却（AGENTS：2 次 → 60s） */
  writeCooldownEvery?: number;
  /** 额外冷却时长（毫秒） */
  writeCooldownMs?: number;
  /** 连续写操作达到该次数后停下等人工确认（AGENTS：3） */
  maxWritesBeforeConfirm?: number;
  /** 注入的时钟与休眠，便于单测 */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultNow = () => Date.now();
const defaultSleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export class PolicyEngine {
  private readonly minReadIntervalMs: number;
  private readonly minWriteIntervalMs: number;
  private readonly writeCooldownEvery: number;
  private readonly writeCooldownMs: number;
  private readonly maxWritesBeforeConfirm: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  /** 串行队列：所有 115 调用都排队，永不并发 */
  private tail: Promise<unknown> = Promise.resolve();
  private lastReadAt: number | null = null;
  private lastWriteAt: number | null = null;
  private writesSinceCooldown = 0;
  /** 连续写操作计数（达到上限后写操作被拒绝，直到 reset） */
  private consecutiveWrites = 0;
  /** 熔断标志 */
  private breakerOpen = false;
  private breakerReason = "";

  constructor(opts: PolicyOptions = {}) {
    this.minReadIntervalMs = opts.minReadIntervalMs ?? 1000;
    this.minWriteIntervalMs = opts.minWriteIntervalMs ?? 3000;
    this.writeCooldownEvery = opts.writeCooldownEvery ?? 2;
    this.writeCooldownMs = opts.writeCooldownMs ?? 60000;
    this.maxWritesBeforeConfirm = opts.maxWritesBeforeConfirm ?? 3;
    this.now = opts.now ?? defaultNow;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  get isBreakerOpen(): boolean {
    return this.breakerOpen;
  }

  get breakerInfo(): string {
    return this.breakerReason;
  }

  get writeCount(): number {
    return this.consecutiveWrites;
  }

  /** 人工确认后调用，重置写计数 */
  confirmWrites(): void {
    this.consecutiveWrites = 0;
  }

  /** 打开熔断（风控命中或人工强制） */
  trip(reason: string): void {
    this.breakerOpen = true;
    this.breakerReason = reason;
  }

  /** 关闭熔断（仅在用户重新登录并确认后） */
  reset(): void {
    this.breakerOpen = false;
    this.breakerReason = "";
    this.consecutiveWrites = 0;
    this.writesSinceCooldown = 0;
  }

  /** 串行执行，并把异常归一化 / 熔断。 */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    // 链条本身吞掉异常，避免一次失败污染后续队列
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 读操作：串行 + 最小间隔。 */
  async read<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.breakerOpen) throw new BreakerOpenError(this.breakerReason);
      await this.waitGap(this.lastReadAt, this.minReadIntervalMs);
      this.lastReadAt = this.now();
      try {
        return await fn();
      } catch (err) {
        this.handleError(err);
        throw toP115Error(err);
      }
    });
  }

  /** 写操作：串行 + ≥3s 间隔 + 每 2 次额外 60s + 连续 3 次停下确认。 */
  async write<T>(fn: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.breakerOpen) throw new BreakerOpenError(this.breakerReason);
      if (this.consecutiveWrites >= this.maxWritesBeforeConfirm) {
        throw new NeedsConfirmationError(
          `已连续执行 ${this.consecutiveWrites} 次写操作，按规则必须停下并等待人工确认（可调用 confirm_writes 继续）。`,
        );
      }
      await this.waitGap(this.lastWriteAt, this.minWriteIntervalMs);
      this.lastWriteAt = this.now();
      this.consecutiveWrites += 1;
      this.writesSinceCooldown += 1;
      try {
        const result = await fn();
        if (this.writesSinceCooldown >= this.writeCooldownEvery) {
          this.writesSinceCooldown = 0;
          await this.sleep(this.writeCooldownMs);
        }
        return result;
      } catch (err) {
        this.handleError(err);
        throw toP115Error(err);
      }
    });
  }

  /** 距上次操作的最小间隔等待。 */
  private async waitGap(lastAt: number | null, minGapMs: number): Promise<void> {
    if (lastAt === null) return;
    const elapsed = this.now() - lastAt;
    const wait = minGapMs - elapsed;
    if (wait > 0) await this.sleep(wait);
  }

  /** 错误处理：命中风控立即熔断。 */
  private handleError(err: unknown): void {
    const e = toP115Error(err);
    if (e.shouldTripBreaker) {
      this.trip(`命中风控信号：${e.raw.slice(0, 300)}`);
    }
  }

  /**
   * 开工前必查（AGENTS 第四节）。
   * @param preflight 实测回调：返回会话/风控/容量/清单时效
   */
  async preflight<T extends { sessionOk: boolean; riskOk: boolean; storageOk: boolean; planFresh: boolean; details?: string }>(
    probe: () => Promise<T>,
  ): Promise<T> {
    const result = await this.read(() => probe());
    const problems: string[] = [];
    if (!result.sessionOk) problems.push("会话未登录或文件接口不可用");
    if (!result.riskOk) problems.push("存在风控标记（violation_info / checking_info 非空）");
    if (!result.storageOk) problems.push("容量信息读取失败");
    if (!result.planFresh) problems.push("计划清单缺失或生成时间超过 48 小时");
    if (problems.length) {
      // 把 details 一并带进消息：只说「清单缺失或超时」用户无从下手，
      // 至少要告诉他命中的是哪个文件、已经过了多少小时（2026-11-23 调试发现）。
      const detail = result.details ? `（${result.details}）` : "";
      throw new P115Error(
        "unknown",
        `开工前必查未通过：${problems.join("；")}${detail}`,
        JSON.stringify(result),
      );
    }
    return result;
  }
}
