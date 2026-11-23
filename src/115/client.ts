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

  /** 请求头（带 Cookie；Cookie 为空时抛会话过期）。 */
  private headers(): Record<string, string> {
    const cookie = this.getCookie();
    if (!cookie) {
      throw new P115Error("session_expired", "115 未登录：缺少 Cookie，请先扫码登录或粘贴 Cookie。");
    }
    return {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
      Referer: "https://115.com/",
    };
  }

  /** 解析 JSON；返回 HTML 时判定为会话/WAF 失效。 */
  private parseJson(res: HttpResponse): any {
    if (res.json === undefined) {
      throw new P115Error(
        "session_expired",
        "115 返回登录页：会话或 acw_tc 已失效，请重新扫码登录。",
        res.text.slice(0, 400),
      );
    }
    return res.json as { state?: boolean; error?: string; errno?: number; data?: any };
  }

  /** 统一请求：带 cookie、解析 JSON、把异常归一化成 P115Error。 */
  private async request(path: string, method: "GET" | "POST", fields: Record<string, string | number | undefined> = {}): Promise<any> {
    let res: HttpResponse;
    try {
      res = await this.transport({
        url: `${WEB}${path}`,
        method,
        headers: this.headers(),
        body: method === "POST" ? form(fields) : undefined,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new P115Error(classifyP115Error(raw), raw, raw);
    }
    const body = this.parseJson(res);
    if (body.state === false) {
      const msg = `${body.error ?? "unknown error"} errno=${body.errno ?? "?"}`;
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 400));
    }
    return body.data ?? body;
  }

  // ------------------------------------------------------------ 只读
  //
  // 端点均按 p115client 的 Web 实现逐条核对过（2026-11-23）：
  //   列目录  GET  https://webapi.115.com/files?aid=1&cid=&limit=&offset=&count_folders=1&record_open_time=1&show_dir=1
  //   账号    GET  https://webapi.115.com/user/info
  //   容量    GET  https://115.com/index.php?ct=ajax&ac=get_storage_info
  //   搜索    GET  https://webapi.115.com/files/search?aid=1&cid=0&limit=1150&offset=0&show_dir=1&search_value=
  //   建目录  POST https://webapi.115.com/files/add            {cname, pid}
  //   重命名  POST https://webapi.115.com/files/batch_rename   {files_new_name[fid]: name}
  //   移动    POST https://webapi.115.com/files/move           {fid, pid}
  //   删除    POST https://webapi.115.com/rb/delete            {fid[]: fid}

  /** 列出目录内容。 */
  async listDir(cid: string = this.rootCid, offset = 0, limit = 1150): Promise<P115ListResult> {
    const qs = new URLSearchParams({
      aid: "1",
      cid: String(cid),
      limit: String(limit),
      offset: String(offset),
      count_folders: "1",
      record_open_time: "1",
      show_dir: "1",
    });
    const data = await this.request(`/files?${qs.toString()}`, "GET");
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

  /** 容量信息（115.com 的 get_storage_info，返回按存储类型分组的 total/used）。 */
  async quota(): Promise<P115Quota> {
    const res = await this.transport({
      url: "https://115.com/index.php?ct=ajax&ac=get_storage_info",
      method: "GET",
      headers: this.headers(),
    });
    const body = this.parseJson(res);
    const data = (body?.data ?? body) as Record<string, any>;
    const main = data?.["1"] ?? data?.["0"] ?? {};
    const total = Number(main.total ?? data.total ?? 0);
    const used = Number(main.used ?? data.used ?? 0);
    return { total, used, free: Math.max(0, total - used) };
  }

  /** 账号信息（含风控标记 violation_info / checking_info）。 */
  async account(): Promise<{ user_id: string; user_name: string; violation_info: unknown[]; checking_info: unknown[] }> {
    const data = await this.request("/user/info", "GET");
    return {
      user_id: String(data?.user_id ?? data?.userId ?? ""),
      user_name: String(data?.user_name ?? data?.userName ?? ""),
      violation_info: Array.isArray(data?.violation_info) ? data.violation_info : [],
      checking_info: Array.isArray(data?.checking_info) ? data.checking_info : [],
    };
  }

  /** 按名称搜索（115 web 搜索接口，GET + search_value）。 */
  async search(query: string, offset = 0, limit = 1150): Promise<P115Entry[]> {
    const qs = new URLSearchParams({
      aid: "1",
      cid: "0",
      limit: String(limit),
      offset: String(offset),
      show_dir: "1",
      search_value: query,
    });
    const data = await this.request(`/files/search?${qs.toString()}`, "GET");
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

  /** 建目录：POST /files/add {cname, pid} */
  async mkdir(pid: string, name: string): Promise<void> {
    await this.request("/files/add", "POST", { cname: name, pid: String(pid) });
  }

  /** 重命名：POST /files/batch_rename {files_new_name[fid]: 新名}（必须带扩展名） */
  async rename(fid: string, newName: string): Promise<void> {
    await this.request("/files/batch_rename", "POST", { [`files_new_name[${fid}]`]: newName });
  }

  /** 移动：POST /files/move {fid, pid}（单次只处理一个） */
  async move(fid: string, toPid: string): Promise<void> {
    await this.request("/files/move", "POST", { fid: String(fid), pid: String(toPid) });
  }

  /** 删除（进回收站）：POST /rb/delete {fid[]: fid} */
  async remove(fid: string): Promise<void> {
    await this.request("/rb/delete", "POST", { "fid[]": String(fid) });
  }
}
