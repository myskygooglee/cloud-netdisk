/**
 * 115 Web API 客户端（只读 + 写操作均在此实现）。
 *
 * 约定：
 *  - 所有请求经 Obsidian 的 `requestUrl`（不走浏览器 CORS）。
 *  - 传输层可注入，便于单测。
 *  - 这里**不做任何重试**：风控/会话错误直接抛 P115Error，由 Policy 层决定熔断。
 */

import { requestUrl } from "obsidian";
import { P115Error, classifyP115Error } from "./errors";
import type { P115Entry, P115ListResult, P115Quota } from "./types";

export interface HttpResponse {
  status: number;
  text: string;
  json?: unknown;
}

export type Transport = (opts: {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}) => Promise<HttpResponse>;

export const httpTransport: Transport = async (opts) => {
  const res = await requestUrl({
    url: opts.url,
    method: opts.method,
    headers: opts.headers,
    body: opts.body,
    throw: false,
  });
  const text = res.text ?? "";
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
};

const WEB = "https://webapi.115.com";

function form(fields: Record<string, string | number | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join("&");
}

export interface ClientOptions {
  transport?: Transport;
  /** 取 cookie 的回调（每次请求时读取，保证扫码登录后立即生效） */
  getCookie: () => string;
  /** 顶层目录 cid，默认 "0" */
  rootCid?: string;
}

export class P115Client {
  private readonly transport: Transport;
  private readonly getCookie: () => string;
  readonly rootCid: string;

  constructor(opts: ClientOptions) {
    this.transport = opts.transport ?? httpTransport;
    this.getCookie = opts.getCookie;
    this.rootCid = opts.rootCid ?? "0";
  }

  /** 统一请求：带 cookie、解析 JSON、把异常归一化成 P115Error。 */
  private async request(path: string, method: "GET" | "POST", fields: Record<string, string | number | undefined> = {}): Promise<any> {
    const cookie = this.getCookie();
    if (!cookie) {
      throw new P115Error("session_expired", "115 未登录：缺少 Cookie，请先在插件设置中扫码登录。");
    }
    const headers: Record<string, string> = {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
      Referer: "https://115.com/",
    };
    let res: HttpResponse;
    try {
      res = await this.transport({
        url: `${WEB}${path}`,
        method,
        headers,
        body: method === "POST" ? form(fields) : undefined,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new P115Error(classifyP115Error(raw), raw, raw);
    }
    if (res.json === undefined) {
      // 返回 HTML = 115 把我们踢到了登录页 / WAF 页面
      throw new P115Error("session_expired", "115 返回登录页：会话或 acw_tc 已失效，请重新扫码登录。", res.text.slice(0, 400));
    }
    const body = res.json as { state?: boolean; error?: string; errno?: number; data?: any };
    if (body.state === false) {
      const msg = `${body.error ?? "unknown error"} errno=${body.errno ?? "?"}`;
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 400));
    }
    return body.data ?? body;
  }

  // ------------------------------------------------------------ 只读

  /** 列出目录内容。 */
  async listDir(cid: string = this.rootCid, offset = 0, limit = 1150): Promise<P115ListResult> {
    const data = await this.request(
      `/files?aid=1&cid=${encodeURIComponent(cid)}&offset=${offset}&limit=${limit}&count_folders=1&show_dir=1&asc=1&cur=1&o=&fc_mix=1`,
      "GET",
    );
    const list: any[] = Array.isArray(data) ? data : (data?.list ?? []);
    const entries: P115Entry[] = list.map((it: any) => ({
      id: String(it.cid ?? it.fid ?? ""),
      cid: it.cid !== undefined ? String(it.cid) : undefined,
      fid: it.fid !== undefined ? String(it.fid) : undefined,
      pid: String(it.pid ?? "0"),
      name: it.n ?? "",
      size: Number(it.s ?? it.file_size ?? 0),
      sha1: it.sha1 || undefined,
      ico: it.ico,
      isDir: it.fc === 0 || it.cid !== undefined,
      mtime: it.t ? Number(it.t) : undefined,
      ctime: it.c ? Number(it.c) : undefined,
      pickcode: it.pc,
    }));
    return { entries, hasMore: entries.length >= limit };
  }

  /** 容量信息。 */
  async quota(): Promise<P115Quota> {
    const data = await this.request("/files/info?aid=1", "GET");
    const total = Number(data?.total ?? data?.total_size ?? 0);
    const used = Number(data?.used ?? data?.used_size ?? 0);
    return { total, used, free: Math.max(0, total - used) };
  }

  /** 账号信息（用于校验登录态）。 */
  async account(): Promise<{ user_id: string; user_name: string }> {
    const data = await this.request("/files/index?aid=1", "GET");
    return {
      user_id: String(data?.user_id ?? data?.userId ?? ""),
      user_name: String(data?.user_name ?? data?.userName ?? ""),
    };
  }

  /** 按名称搜索（115 web 搜索接口）。 */
  async search(query: string, page = 1): Promise<P115Entry[]> {
    const data = await this.request("/files/search?aid=1", "POST", { searchval: query, page });
    const list: any[] = Array.isArray(data) ? data : (data?.data?.list ?? data?.list ?? []);
    return list.map((it: any) => ({
      id: String(it.cid ?? it.fid ?? ""),
      cid: it.cid !== undefined ? String(it.cid) : undefined,
      fid: it.fid !== undefined ? String(it.fid) : undefined,
      pid: String(it.pid ?? "0"),
      name: it.n ?? it.file_name ?? "",
      size: Number(it.s ?? it.size ?? 0),
      sha1: it.sha1 || undefined,
      ico: it.ico,
      isDir: it.fc === 0 || it.cid !== undefined,
    }));
  }

  // ------------------------------------------------------------ 写操作（调用方必须先过 Policy）

  async mkdir(pid: string, name: string): Promise<void> {
    await this.request("/files/add?aid=1", "POST", { pid, cname: name });
  }

  async rename(fid: string, newName: string): Promise<void> {
    await this.request("/files/batch_rename?aid=1", "POST", { "fid_list[]": fid, file_name: newName });
  }

  async move(fid: string, toPid: string): Promise<void> {
    await this.request("/files/move?aid=1", "POST", { "fid_list[]": fid, to_pdir_id: toPid });
  }

  async remove(fid: string): Promise<void> {
    await this.request("/files/delete?aid=1", "POST", { "fid[]": fid });
  }
}
