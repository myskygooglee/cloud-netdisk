/**
 * 115-MCP-Server（Python 侧）路径探测。
 *
 * 背景（2026-11-23 调试）：这套路径原先硬编码成 `D:\115-MCP-Server\...`，
 * 而实际机器上 Python 侧在 `E:\115-MCP-Server\` —— 插件设置页显示正常，
 * 实际调用全部落空（备份按钮找不到脚本、锁目录不存在、清单目录不存在）。
 * 硬编码盘符是这类"看起来配好了、其实全错"的根源，所以改成**运行时探测**。
 *
 * 探测顺序（第一个存在即用）：
 *   1. 环境变量 `P115_MCP_SERVER_HOME`（最优先，便于多机部署）
 *   2. `E:\115-MCP-Server` / `D:\115-MCP-Server` / `C:\115-MCP-Server`
 *   3. 插件仓库同级目录 `..\115-MCP-Server`
 *
 * 判定"存在"的标准：目录里有 `src` 或 `scripts` 或 `115-cookies.txt` 之一
 * （避免把同名空目录当成真的服务器目录）。
 */

import { existsSync } from "fs";
import { join, resolve } from "path";

/** 候选根目录（按优先级）。 */
const CANDIDATE_ROOTS = [
  "E:\\115-MCP-Server",
  "D:\\115-MCP-Server",
  "C:\\115-MCP-Server",
];

/** 判断一个目录看起来像 115-MCP-Server 根目录。 */
export function looksLikeServerRoot(dir: string): boolean {
  try {
    return (
      existsSync(join(dir, "src")) ||
      existsSync(join(dir, "scripts")) ||
      existsSync(join(dir, "115-cookies.txt"))
    );
  } catch {
    return false;
  }
}

/** 探测 115-MCP-Server 根目录；找不到返回空串。 */
export function detectServerRoot(): string {
  const fromEnv = (process.env.P115_MCP_SERVER_HOME ?? "").trim();
  if (fromEnv && looksLikeServerRoot(fromEnv)) return resolve(fromEnv);
  for (const c of CANDIDATE_ROOTS) {
    if (looksLikeServerRoot(c)) return c;
  }
  return "";
}

/** 探测结果 + 各派生路径；`root` 为空表示没找到（调用方应提示用户手动配置）。 */
export interface ServerPaths {
  root: string;
  /** 跨进程锁目录（与 Python 侧共用 115.lock.json） */
  lockDir: string;
  /** 清单目录（preflight 的 48h 时效检查） */
  stateDir: string;
  /** 一键备份脚本 */
  backupScript: string;
  /** Python 解释器 */
  python: string;
  /** 115 cookie 文件（Python 侧，与插件的 data.json 不是同一份） */
  cookiesFile: string;
}

/** 探测 115-MCP-Server 的全部关键路径。 */
export function detectServerPaths(): ServerPaths {
  const root = detectServerRoot();
  if (!root) {
    return {
      root: "",
      lockDir: "",
      stateDir: "",
      backupScript: "",
      python: "",
      cookiesFile: "",
    };
  }
  return {
    root,
    lockDir: join(root, "state"),
    // 清单目录优先用 _preview（盘点产物放这里），没有则退回 state
    stateDir: existsSync(join(root, "_preview")) ? join(root, "_preview") : join(root, "state"),
    backupScript: join(root, "scripts", "vault_backup_115.py"),
    python: join(root, ".venv", "Scripts", "python.exe"),
    cookiesFile: join(root, "115-cookies.txt"),
  };
}

/** 路径是否存在（设置页自检用）。 */
export function pathExists(p: string): boolean {
  if (!p) return false;
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 判断某个路径是不是**另一套** 115-MCP-Server 根目录下的路径。
 *
 * 2026-11-23 调试踩到：`D:\115-MCP-Server\state` 恰好存在（只留了一个
 * `115.plugin_activity.json`），于是「路径不存在 ⇒ 迁移」这条规则不触发，
 * 插件继续往 D:\ 写活动标记，而 Python 侧已经改用 E:\ —— 两边读的不是同一把锁，
 * 跨进程互斥直接失效。
 *
 * 判据：路径里含有 `115-MCP-Server`，但根目录不是当前探测到的那一套。
 */
export function isForeignServerPath(p: string, root: string): boolean {
  if (!p) return false;
  if (!p.toLowerCase().includes("115-mcp-server")) return false;
  const norm = (s: string) => s.replace(/[\\/]+$/, "").toLowerCase();
  return !norm(p).startsWith(norm(root));
}
