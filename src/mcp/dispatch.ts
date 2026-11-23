/**
 * 工具调用分发：MCP tools/call → Policy → Client → Audit。
 *
 * 所有 115 调用都必须经由 PolicyEngine（串行 / 限速 / 熔断 / 写计数）。
 */

import { AuthManager } from "../115/auth";
import { P115Client } from "../115/client";
import { P115Error } from "../115/errors";
import type { P115Entry } from "../115/types";
import { rawNum, rawStr } from "../115/types";
import { AuditLog } from "../policy/audit";
import { BreakerOpenError, NeedsConfirmationError, PolicyEngine } from "../policy/engine";
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
  /** 计划清单 48h 时效检查（AGENTS 第四节） */
  planFresh?: () => { fresh: boolean; detail: string };
  /** 跨进程 115 锁守卫：返回 locked=true 时拒绝本次请求 */
  crossLock?: () => { locked: boolean; detail: string };
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** 策略层主动拒绝（不是 115 报错）：也要落审计，留下「agent 试过但被拦下」的痕迹。 */
export class PolicyRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRejectedError";
  }
}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export class ToolDispatcher {
  constructor(private readonly deps: DispatchDeps) {}

  private get client(): P115Client {
    return this.deps.auth.getClient();
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const def = TOOLS.find((t) => t.name === name);
    if (!def) return fail(`未知工具：${name}`);

    // 只读模式闸门：写工具默认关闭（先只读跑通链路，再逐步放开）
    if (def.mutating && !this.deps.isWriteEnabled()) {
      return fail(
        `工具 ${name} 属于写操作，当前插件处于「只读模式」。请在 Obsidian 设置 → 115 Cloud → 放开写工具 后重试。`,
      );
    }

    // 跨进程闸门：Python 批处理持锁期间，插件连只读都不放行（AGENTS：禁止并发）
    if (this.deps.crossLock) {
      const st = this.deps.crossLock();
      if (st.locked) {
        const text = `⛔ 115 批处理正在运行，插件暂停所有 115 请求以避免并发撞风控。\n${st.detail}\n等批处理结束后重试（锁心跳 90s 未刷新会自动视为陈旧）。`;
        this.deps.audit.write({ action: `tool:${name}`, result: "failed", detail: `cross_process_lock: ${st.detail}` });
        return fail(text);
      }
    }

    try {
      switch (name) {
        case "list_dir": {
          const cid = (rawStr(args.cid) || this.client.rootCid);
          const offset = rawNum(args.offset);
          const limit = Math.min(rawNum(args.limit, 200), 1000);
          const res = await this.deps.policy.read(() => this.client.listDir(cid, offset, limit));
          const head = {
            cid,
            total: res.total,
            hasMore: res.hasMore,
            path: res.path,
          };
          return ok(JSON.stringify({ ...head, entries: res.entries.map(brief) }, null, 2));
        }
        case "stat": {
          const target = rawStr(args.cid_or_fid);
          if (!target || target === "0") return fail("stat 需要具体的 cid 或 fid（根目录不支持）");
          const hit = await this.deps.policy.read(() => this.client.stat(target));
          if (!hit) return fail(`未找到目标：${target}`);
          return ok(JSON.stringify(brief(hit), null, 2));
        }
        case "search": {
          const q = rawStr(args.query).trim();
          if (!q) return fail("search 需要非空关键词");
          const page = Math.max(1, rawNum(args.page, 1));
          const limit = Math.min(rawNum(args.limit, 100), 1000);
          const res = await this.deps.policy.read(() => this.client.search(q, (page - 1) * limit, limit));
          return ok(JSON.stringify({ query: q, page, count: res.length, entries: res.map(brief) }, null, 2));
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
          const fresh = this.deps.planFresh?.() ?? { fresh: true, detail: "未配置清单时效检查" };
          const result = await this.deps.policy.preflight(async () => {
            const health = await this.deps.auth.healthCheck();
            let storageOk = true;
            let storageDetail = "";
            try {
              const q = await this.client.quota();
              storageDetail = `已用 ${q.used} / 总 ${q.total}`;
            } catch (err) {
              storageOk = false;
              storageDetail = (err as Error).message;
            }
            return {
              sessionOk: health.hasCookie && health.fileApiOk,
              riskOk: !health.hasRisk,
              storageOk,
              planFresh: fresh.fresh,
              details: [health.reason, storageDetail, fresh.detail].filter(Boolean).join("；"),
            };
          });
          return ok(JSON.stringify(result, null, 2));
        }
        case "mkdir": {
          const pid = rawStr(args.pid);
          const dirName = rawStr(args.name);
          const created = await this.deps.policy.write(() => this.client.mkdir(pid, dirName));
          this.deps.audit.write({
            action: "mkdir",
            cid: created?.cid,
            path: `${pid}/${dirName}`,
            result: "ok",
          });
          return ok(
            created?.cid
              ? `已创建目录 ${dirName}，cid=${created.cid}（父目录 cid=${pid}）`
              : `已创建目录 ${dirName}（父目录 cid=${pid}）`,
          );
        }
        case "rename": {
          const fid = rawStr(args.fid);
          const newName = rawStr(args.new_name);
          await this.deps.policy.write(() => this.client.rename(fid, newName));
          this.deps.audit.write({ action: "rename", fid, path: newName, result: "ok" });
          return ok(`已重命名为 ${newName}`);
        }
        case "move": {
          const fid = rawStr(args.fid);
          const toPid = rawStr(args.to_pid);
          await this.deps.policy.write(() => this.client.move(fid, toPid));
          this.deps.audit.write({ action: "move", fid, path: toPid, result: "ok" });
          return ok(`已移动（fid=${fid} → 目录 cid=${toPid}）`);
        }
        case "quarantine": {
          const fid = rawStr(args.fid);
          const fileName = rawStr(args.name);
          const size = rawNum(args.size);
          const decision = decideDeletionRoute(fileName, size);
          if (decision.route === "direct_delete") {
            throw new PolicyRejectedError(
              `该文件类型（${fileName}）属于白名单小垃圾，应使用 delete_small_garbage，而非 quarantine。`,
            );
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
          const fid = rawStr(args.fid);
          const fileName = rawStr(args.name);
          const size = rawNum(args.size);
          const decision = decideDeletionRoute(fileName, size);
          if (decision.route !== "direct_delete") {
            throw new PolicyRejectedError(`拒绝直接删除：${decision.reason}。请改用 quarantine。`);
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
      // 策略层拒绝：也要落审计（原缺口：被拦下的动作在账本里看不见）
      if (err instanceof PolicyRejectedError) {
        this.deps.audit.write({
          action: `tool:${name}`,
          fid: args.fid !== undefined ? rawStr(args.fid) : undefined,
          size: args.size !== undefined ? rawNum(args.size) : undefined,
          path: args.name !== undefined ? rawStr(args.name) : undefined,
          result: "failed",
          detail: `policy_rejected: ${err.message}`,
        });
        return fail(err.message);
      }
      if (err instanceof NeedsConfirmationError) {
        this.deps.audit.write({
          action: `tool:${name}`,
          result: "failed",
          detail: `needs_confirmation: ${err.message}`,
        });
        return fail(err.message);
      }
      if (err instanceof BreakerOpenError) {
        return fail(`⛔ ${err.message} 请先在插件设置里重新登录并「重置熔断」后再试。`);
      }
      const e = err instanceof P115Error ? err : new P115Error("unknown", (err as Error).message);
      this.deps.audit.write({
        action: `tool:${name}`,
        fid: args.fid !== undefined ? rawStr(args.fid) : undefined,
        size: args.size !== undefined ? rawNum(args.size) : undefined,
        result: "failed",
        detail: e.raw || e.message,
      });
      return fail(`${e.kind}: ${e.message}`);
    }
  }
}

function brief(e: P115Entry) {
  return {
    // id：目录=cid，文件=fid（可直接用于 move / rename / quarantine / delete）
    id: e.id,
    cid: e.cid,
    fid: e.fid,
    name: e.name,
    isDir: e.isDir,
    size: e.size,
    sha1: e.sha1,
    pid: e.pid,
    ico: e.ico,
    mtime: e.mtime,
  };
}
