/**
 * 隔离策略：视频 / 归档文件一律先隔离，不直接删。
 *
 * AGENTS.md：
 *  - 视频 / 归档文件一律先隔离，不直接删 → 移动到 `_去重待删_YYYYMMDD/`
 *  - 例外：确证的垃圾小文件可直删，仅限 jpg/png/url/txt/html/gif/torrent/mht 等，
 *    且属于 `quarantine_115.py --tier nonvideo` 覆盖范围；其余删除一律走隔离目录。
 */

export type DeletionRoute = "quarantine" | "direct_delete" | "refuse";

export interface RouteDecision {
  route: DeletionRoute;
  /** 命中的规则说明（用于给 agent / 用户解释） */
  reason: string;
  /** direct_delete 时的隔离目录名（可选） */
  quarantineDir?: string;
}

/** 视频扩展名（需要隔离） */
export const VIDEO_EXT = new Set([
  ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".ts", ".m2ts", ".rmvb", ".rm",
  ".mpg", ".mpeg", ".webm", ".m4v", ".3gp", ".vob", ".asf", ".f4v", ".mts",
]);

/** 归档扩展名（需要隔离） */
export const ARCHIVE_EXT = new Set([
  ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".iso", ".cab", ".tgz",
  ".tbz2", ".txz", ".z", ".pkg", ".dmg",
]);

/** 允许直接删除的小垃圾文件扩展名（严格白名单） */
export const DIRECT_DELETE_EXT = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp",
  ".url", ".txt", ".html", ".htm", ".torrent", ".mht",
]);

/** 隔离目录名（按日期） */
export function quarantineDirName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `_去重待删_${y}${m}${d}`;
}

export function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return "";
  return name.slice(idx).toLowerCase();
}

/** 决定一个条目的删除路径。 */
export function decideDeletionRoute(name: string, sizeBytes: number, now: Date = new Date()): RouteDecision {
  const ext = extOf(name);
  if (VIDEO_EXT.has(ext)) {
    return { route: "quarantine", reason: `视频文件（${ext}）必须先隔离，不直接删`, quarantineDir: quarantineDirName(now) };
  }
  if (ARCHIVE_EXT.has(ext)) {
    return { route: "quarantine", reason: `归档文件（${ext}）必须先隔离，不直接删`, quarantineDir: quarantineDirName(now) };
  }
  if (DIRECT_DELETE_EXT.has(ext)) {
    return {
      route: "direct_delete",
      reason: `白名单小垃圾文件（${ext}）允许直接删除，删除后仍在回收站`,
    };
  }
  return {
    route: "refuse",
    reason: `扩展名 ${ext || "(无)"} 不在白名单内，按规则一律走隔离目录`,
  };
}
