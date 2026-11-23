/**
 * 115 错误分类。
 *
 * 库内硬规则（AGENTS.md）：
 *   返回中包含 `429`、`405`、`990001`、`风控`、`频繁` 等字样时，立即停止所有 115 操作。
 * 因此这里只要命中这些信号，一律按「风控 / 熔断」处理，绝不自动重试。
 */

export type P115ErrorKind =
  | "risk_control" // 命中风控关键词：429 / 405 / 990001 / 风控 / 频繁
  | "session_expired" // 会话过期（登录页返回、acw_tc 失效）
  | "not_found" // 目标不存在（errno 90008）
  | "network"
  | "unknown";

export const RISK_KEYWORDS = ["429", "405", "990001", "风控", "频繁"] as const;

export class P115Error extends Error {
  readonly kind: P115ErrorKind;
  readonly raw: string;

  constructor(kind: P115ErrorKind, message: string, raw: string = "") {
    super(message);
    this.name = "P115Error";
    this.kind = kind;
    this.raw = raw;
  }

  /** 是否应当立即熔断、停止所有 115 操作 */
  get shouldTripBreaker(): boolean {
    return this.kind === "risk_control";
  }
}

/** 从任意错误/响应文本中判断类别。 */
export function classifyP115Error(text: string): P115ErrorKind {
  const s = text ?? "";
  if (RISK_KEYWORDS.some((kw) => s.includes(kw))) return "risk_control";
  if (s.includes("登录") || s.includes("login") || s.includes("<!DOCTYPE html>")) return "session_expired";
  if (s.includes("90008") || s.includes("不存在") || s.includes("已删除")) return "not_found";
  if (s.includes("ENOTFOUND") || s.includes("ECONNRESET") || s.includes("ETIMEDOUT")) return "network";
  return "unknown";
}

/** 统一把异常转成 P115Error。 */
export function toP115Error(err: unknown): P115Error {
  if (err instanceof P115Error) return err;
  const raw = err instanceof Error ? err.message : String(err);
  return new P115Error(classifyP115Error(raw), raw, raw);
}
