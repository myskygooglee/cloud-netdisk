/**
 * 审计日志：所有 115 写操作落盘 JSONL，便于复核与回溯。
 * AGENTS.md 第三节要求盘点/操作结果落盘，字段至少包含 fid / size / sha1 / 完整路径。
 */

import { appendFileSync, readFileSync } from "fs";
import { join } from "path";

export interface AuditRecord {
  ts: string;
  action: string;
  fid?: string;
  cid?: string;
  size?: number;
  sha1?: string;
  /** 完整路径（人类可读） */
  path?: string;
  result: "ok" | "failed";
  detail?: string;
}

export class AuditLog {
  constructor(private readonly dir: string, private readonly filename = "115_audit.jsonl") {}

  private get file(): string {
    return join(this.dir, this.filename);
  }

  write(rec: Omit<AuditRecord, "ts"> & { ts?: string }): AuditRecord {
    const full: AuditRecord = { ts: rec.ts ?? new Date().toISOString(), ...rec };
    try {
      appendFileSync(this.file, JSON.stringify(full) + "\n", "utf-8");
    } catch {
      // 审计写入失败不能影响主流程
    }
    return full;
  }

  /** 读取最近 N 条（UI 展示用）。 */
  readRecent(limit = 50): AuditRecord[] {
    try {
      const content = readFileSync(this.file, "utf-8") as string;
      const lines = content.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((l) => {
          try {
            return JSON.parse(l) as AuditRecord;
          } catch {
            return null;
          }
        })
        .filter((x): x is AuditRecord => x !== null);
    } catch {
      return [];
    }
  }
}
