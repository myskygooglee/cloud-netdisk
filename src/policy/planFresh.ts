/**
 * 计划清单时效检查（AGENTS 第四节：计划文件必须生成于 48 小时内）。
 *
 * 做法：只看文件 mtime，不解析内容 —— 目的是拦住「拿一份过期清单去批量动 115」。
 * 目录为空或不可读时，返回 fresh=false 并给出具体原因（宁严勿松）。
 */

import { existsSync, readdirSync, statSync } from "fs";
import { basename, resolve } from "path";

export interface PlanFreshness {
  fresh: boolean;
  detail: string;
  /** 命中的清单文件（人类可读） */
  file?: string;
  /** 清单生成时间（ISO） */
  mtime?: string;
  /** 已过去多少小时 */
  ageHours?: number;
}

/** 优先看这些文件名；都没有时退化为「目录里最新的 .jsonl」。 */
const PREFERRED = [
  "dedup2_remaining_verified.jsonl",
  "115_inventory.jsonl",
  "dedup2_plan_fixed.jsonl",
  "dedup2_plan.jsonl",
];

export function checkPlanFreshness(stateDir: string, maxAgeHours: number, now = Date.now()): PlanFreshness {
  const dir = (stateDir ?? "").trim();
  if (!dir) return { fresh: false, detail: "未配置清单目录（设置页可填），按 AGENTS 视为无清单" };
  const abs = resolve(dir);
  if (!existsSync(abs)) return { fresh: false, detail: `清单目录不存在：${abs}` };

  let target = PREFERRED.map((n) => resolve(abs, n)).find((p) => existsSync(p));
  if (!target) {
    // 退化：目录下任意 .jsonl 里最新的那个
    let newest = 0;
    let newestPath = "";
    for (const name of listJsonl(abs)) {
      const full = resolve(abs, name);
      const m = statSync(full).mtimeMs;
      if (m > newest) {
        newest = m;
        newestPath = full;
      }
    }
    if (!newestPath) return { fresh: false, detail: `清单目录里没有 .jsonl：${abs}` };
    target = newestPath;
  }

  const st = statSync(target);
  const ageHours = (now - st.mtimeMs) / 3_600_000;
  const detail =
    `${basename(target)} 生成于 ${new Date(st.mtimeMs).toISOString()}，` +
    `已过 ${ageHours.toFixed(1)}h（阈值 ${maxAgeHours}h）`;
  return {
    fresh: ageHours <= maxAgeHours,
    detail,
    file: target,
    mtime: new Date(st.mtimeMs).toISOString(),
    ageHours: Number(ageHours.toFixed(2)),
  };
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".jsonl"));
  } catch {
    return [];
  }
}
