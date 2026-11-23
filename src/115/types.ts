/** 115 Web API 条目与目录的类型定义（精简版，只覆盖插件需要的字段）。 */

export interface P115Entry {
  /** 目录 cid 或文件 fid */
  id: string;
  /** 目录 cid（文件为 undefined） */
  cid?: string;
  /** 文件 fid（目录为 undefined） */
  fid?: string;
  /** 父目录 cid */
  pid: string;
  /** 名称 */
  name: string;
  /** 大小（字节，目录为 0） */
  size: number;
  /** sha1（大文件时可能缺失） */
  sha1?: string;
  /** 文件类型图标，如 mp4 / jpg / zip */
  ico?: string;
  /** 是否目录 */
  isDir: boolean;
  /** 时间戳（秒） */
  mtime?: number;
  ctime?: number;
  /** 取速链接 */
  pickcode?: string;
}

/**
 * 115 Web API 的原始条目（短字段名）。
 *
 * 115 用一套极短的字段名返回目录/文件，实测（2026-11-23）：
 *  - 目录只有 `cid`，文件同时有 `cid` 和 `fid`，且两者不同；
 *  - 大小是 `s`（字符串），sha1 是 `sha`（大写十六进制），mtime 是 `te`（秒）；
 *  - `fc` 为 0 表示目录。
 *
 * 这些字段全部可选：不同接口（列目录 / 搜索 / 元数据）返回的键并不完全一致，
 * 映射层统一按 `??` 兜底。
 */
export interface Raw115Entry {
  fid?: string | number;
  fc?: string | number;
  cid?: string | number;
  pid?: string | number;
  /** 名称 */
  n?: string;
  file_name?: string;
  /** 大小（可能是字符串） */
  s?: string | number;
  size?: string | number;
  file_size?: string | number;
  sha?: string;
  sha1?: string;
  /** 文件类型图标 */
  ico?: string;
  /** 修改时间（秒） */
  te?: string | number;
  tp?: string | number;
  t?: string | number;
  /** 创建时间（秒） */
  c?: string | number;
  /** 取速链接 */
  pc?: string;
  pickcode?: string;
}

/** 115 接口的通用响应外壳（`data` 拆壳前）。 */
export interface Raw115Envelope {
  state?: boolean;
  error?: string;
  errno?: number;
  data?: unknown;
  /** 列表接口的总条数 */
  count?: number;
  /** 列表接口返回的从根到当前目录的链路 */
  path?: Array<{ cid?: string | number; name?: string }>;
}

/** 115 接口的扁平对象（`data` 拆壳后）。 */
export type Raw115Object = Record<string, unknown>;

/** 把接口返回的未知值安全转成字符串（对象/数组一律返回空串，避免 `[object Object]`）。 */
export function rawStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** 把接口返回的未知值安全转成数字。 */
export function rawNum(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export interface P115Quota {
  /** 总容量（字节） */
  total: number;
  /** 已用（字节） */
  used: number;
  /** 剩余（字节） */
  free: number;
}

export interface P115ListResult {
  /** 本目录下的条目 */
  entries: P115Entry[];
  /** 该目录下的总条目数（115 的 `count`） */
  total?: number;
  /** 是否还有下一页 */
  hasMore: boolean;
  /** 从根到当前目录的链路（面包屑） */
  path?: Array<{ cid: string; name: string }>;
}

/** 容量单位换算：115 后端返回的是 TiB 口径的字节数，这里统一按 TiB/GiB 显示。 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let value = Math.abs(bytes);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${(bytes < 0 ? -value : value).toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}
