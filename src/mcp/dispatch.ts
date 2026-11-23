/**
 * 工具调用分发：MCP tools/call → Policy → Client → Audit。
 *
 * 所有 115 调用都必须经由 PolicyEngine（串行 / 限速 / 熔断 / 写计数）。
 */

import { AuthManager } from "../115/auth";
import { P115Client } from "../115/client";
import { P115Error } from "../115/errors";
import type { P115Entry } from "../115/types";
import { AuditLog } from "../policy/audit";
import { PolicyEngine } from "../policy/engine";
import { decideDeletionRoute, quarantineDirName } from "../policy/quarantine";
import { TOOLS } from "./tools";

export interface DispatchDeps {
  auth: AuthManager;
  policy: PolicyEngine;
  audit: AuditLog;
  /** 解析隔离目录 cid（不存在则创建） */
  ensureQuarantineDir: (name: string) => Promise<string>;
  /** 是否放开写工具（默认只读） */
  isWriteEnabled: () => boolean;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export class ToolDispatcher {
  constructor(private readonly deps: DispatchDeps) {}

  private get client(): P115Client {
    return this.deps.auth.getClient();
  }

  async call(name: string, args: Record<string, any>): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return fail(`未知工具：${name}`);

    // 只读模式闸门：写工具默认关闭（先只读跑通链路，再逐步放开）
    if (def.mutating && !this.deps.isWriteEnabled()) {
      return fail(
        `工具 ${name} 属于写操作，当前插件处于「只读模式」。请在 Obsidian 设置 → 115 Cloud → 放开写工具 后重试。`,
      );
    }

    try {
      switch (name) {
        case "list_dir": {
          const cid = String(args.cid ?? this.client.rootCid);
          const res = await this.deps.policy.read(() => this.client.listDir(cid));
          return ok(JSON.stringify(res.entries.map(brief), null, 2));
        }
        case "stat": {
          const target = String(args.cid_or_fid);
          const res = await this.deps.policy.read(() => this.client.listDir(target === "0" ? target : target, 0, 1150));
          const hit = res.entries.find((e) => e.id === target);
          if (!hit) return fail(`未找到目标：${target}`);
          return ok(JSON.stringify(brief(hit), null, 2));
        }
        case "search": {
          const q = String(args.query ?? "");
          const page = Number(args.page ?? 1);
          const res = await this.deps.policy.read(() => this.client.search(q, page));
          return ok(JSON.stringify(res.map(brief), null, 2));
        }
        case "quota": {
          const q = await this.deps.policy.read(() => this.client.quota());
          return ok(JSON.stringify(q, null, 2));
        }
        case "health": {
          const state = await this.deps.auth.healthCheck();
          return ok(JSON.stringify(state, null, 2));
        }
        case "preflight": {
          const result = await this.deps.policy.preflight(async () => {
            const health = await this.deps.auth.healthCheck();
            let storageOk = true;
            try {
              await this.client.quota();
            } catch {
              storageOk = false;
            }
            return {
              sessionOk: health.hasCookie && health.fileApiOk,
              riskOk: true, // violation_info / checking_info 由账号接口补充，TODO(M2)
              storageOk,
              planFresh: true, // TODO(M3)：接入 state\*.jsonl 的 48h 时效检查
              details: health.reason,
            };
          });
          return ok(JSON.stringify(result, null, 2));
        }
        case "mkdir": {
          const pid = String(args.pid);
          const dirName = String(args.name);
          await this.deps.policy.write(() => this.client.mkdir(pid, dirName));
          this.deps.audit.write({ action: "mkdir", path: `${pid}/${dirName}`, result: "ok" });
          return ok(`已创建目录 ${dirName}（父目录 cid=${pid}）`);
        }
        case "rename": {
          const fid = String(args.fid);
          const newName = String(args.new_name);
          await this.deps.policy.write(() => this.client.rename(fid, newName));
          this.deps.audit.write({ action: "rename", fid, path: newName, result: "ok" });
          return ok(`已重命名为 ${newName}`);
        }
        case "move": {
          const fid = String(args.fid);
          const toPid = String(args.to_pid);
          await this.deps.policy.write(() => this.client.move(fid, toPid));
          this.deps.audit.write({ action: "move", fid, path: toPid, result: "ok" });
          return ok(`已移动（fid=${fid} → 目录 cid=${toPid}）`);
        }
        case "quarantine": {
          const fid = String(args.fid);
          const fileName = String(args.name);
          const size = Number(args.size ?? 0);
          const decision = decideDeletionRoute(fileName, size);
          if (decision.route !== "quarantine" && decision.route !== "refuse") {
            return fail(`该文件类型（${fileName}）应使用 delete_small_garbage，而非 quarantine。`);
          }
          const dirName = decision.quarantineDir ?? quarantineDirName();
          const quarantineCid = await this.deps.ensureQuarantineDir(dirName);
          await this.deps.policy.write(() => this.client.move(fid, quarantineCid));
          this.deps.audit.write({
            action: "quarantine",
            fid,
            size,
            path: `${dirName}/${fileName}`,
            result: "ok",
            detail: decision.reason,
          });
          return ok(`已隔离到 ${dirName}/（${decision.reason}）。人工确认后可清空隔离目录。`);
        }
        case "delete_small_garbage": {
          const fid = String(args.fid);
          const fileName = String(args.name);
          const size = Number(args.size ?? 0);
          const decision = decideDeletionRoute(fileName, size);
          if (decision.route !== "direct_delete") {
            return fail(`拒绝直接删除：${decision.reason}。请改用 quarantine。`);
          }
          await this.deps.policy.write(() => this.client.remove(fid));
          this.deps.audit.write({
            action: "delete_small_garbage",
            fid,
            size,
            path: fileName,
            result: "ok",
            detail: decision.reason,
          });
          return ok(`已删除 ${fileName}（仍在 115 回收站内）`);
        }
        case "confirm_writes": {
          this.deps.policy.confirmWrites();
          return ok("已确认，继续写操作。");
        }
        default:
          return fail(`工具 ${name} 尚未实现`);
      }
    } catch (err) {
      const e = err instanceof P115Error ? err : new P115Error("unknown", (err as Error).message);
      this.deps.audit.write({
        action: `tool:${name}`,
        result: "failed",
        detail: e.raw || e.message,
      });
      return fail(`${e.kind}: ${e.message}`);
    }
  }
}

function brief(e: P115Entry) {
  return {
    id: e.id,
    name: e.name,
    isDir: e.isDir,
    size: e.size,
    sha1: e.sha1,
    pid: e.pid,
    ico: e.ico,
    mtime: e.mtime,
  };
}
