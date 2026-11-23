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
  /** 是否还有下一页 */
  hasMore: boolean;
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
