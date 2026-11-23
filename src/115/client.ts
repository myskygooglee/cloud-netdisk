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
import { describeEnvelopeError, isFailedEnvelope, rawStr } from "./types";
import type {
  P115Entry,
  P115ListResult,
  P115Quota,
  Raw115Entry,
  Raw115Envelope,
  Raw115Object,
} from "./types";

export interface HttpResponse {
  status: number;
  text: string;
  json?: unknown;
  /** 二进制响应（图片等）的 base64；非二进制时为 undefined */
  base64?: string;
  /** response 的 Content-Type */
  contentType?: string;
  /** 响应头（小写键） */
  headers?: Record<string, string>;
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
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
  return { status: res.status, text, json, headers };
};

/** 从 Set-Cookie 里取出 `acw_tc`（115 的会话粘性 cookie）。 */
export function pickAcwTc(setCookie: string | undefined): string {
  if (!setCookie) return "";
  const m = /(?:^|[,\s])acw_tc=([^;,\s]+)/i.exec(setCookie);
  return m ? m[1] : "";
}

/** 登录相关、需要从 Set-Cookie 里收集的 cookie 名（115 登录后下发的就是这几个）。 */
const LOGIN_COOKIE_NAMES = ["UID", "CID", "SEID", "KID", "acw_tc", "PHPSESSID", "USERSESSIONID"];

/**
 * 从 `Set-Cookie` 响应头里抽出登录需要的 cookie，拼成 Cookie 请求头格式。
 *
 * 背景（2026-11-23 实测）：115 已把登录结果从响应体的 `data.cookie`
 * 改成用多条 `Set-Cookie` 下发（响应体只剩 user_id / user_name 等资料）。
 * 这里两种都兼容 —— 老格式仍走 `data.cookie`，新格式靠这个函数。
 *
 * 注意 Obsidian 的 `requestUrl` 把多条 Set-Cookie 合并进一个字符串，
 * 可能是逗号分隔也可能是换行分隔，两种都处理；同时兼容 `Expires=Wed, 21 Oct ...`
 * 这种值里自带逗号的属性（只在 `name=` 位置切分）。
 */
export function cookiesFromSetCookie(setCookie: string | undefined): string {
  if (!setCookie) return "";
  const found = new Map<string, string>();
  // 只按「行首或分隔符之后紧跟 <NAME>=」切，避免被 Expires 里的逗号误伤
  const re = /(?:^|[\n,;])\s*([A-Za-z_][A-Za-z0-9_]*)=([^;,\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(setCookie)) !== null) {
    const name = m[1];
    const value = m[2].trim();
    if (!LOGIN_COOKIE_NAMES.some((n) => n.toLowerCase() === name.toLowerCase())) continue;
    if (!value) continue;
    found.set(name, value);
  }
  return Array.from(found.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** 响应里所有 cookie（含未列入白名单的），用于诊断输出。 */
export function allCookiesFromSetCookie(setCookie: string | undefined): string[] {
  if (!setCookie) return [];
  const out: string[] = [];
  const re = /(?:^|[\n,])\s*([A-Za-z_][A-Za-z0-9_]*)=([^;\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(setCookie)) !== null) out.push(`${m[1]}=${m[2]}`);
  return out;
}

const WEB = "https://webapi.115.com";

/**
 * 把 115 的原始条目（`n` / `s` / `sha` / `fc` / `te` 这套短字段名）映射成 P115Entry。
 *
 * 关键点（2026-11-23 实测）：
 *  - **目录只有 cid，文件同时有 cid 和 fid，且两者不同**。所以 `id` 必须按 fc 区分，
 *    否则拿 cid 当 fid 去 move/delete 会打错对象。
 *  - 大小字段是 `s`（字符串），sha1 字段是 `sha`（大写十六进制），mtime 是 `te`（秒）。
 *  - 搜索接口会把关键词用 <b> 高亮塞进 `n` 里，这里取纯文本 `n`（115 同时给 `n` 已是纯文本）。
 */
function mapEntry(it: Raw115Entry): P115Entry {
  const hasFid = it.fid !== undefined && it.fid !== null && it.fid !== "";
  const fc = it.fc === undefined ? undefined : Number(it.fc);
  const isDir = fc === 0 || (!hasFid && it.cid !== undefined);
  const ownCid = it.cid !== undefined && it.cid !== null ? String(it.cid) : undefined;
  // 115 的语义（2026-11-23 用真实数据核对）：目录的 cid 是它自己的 id（pid 是父），
  // 文件的 cid 是**父目录** id（pid 恒为 0）。所以文件的父目录要从 cid 取。
  const pid = isDir ? String(it.pid ?? "0") : String(it.cid ?? it.pid ?? "0");
  const id = isDir ? String(ownCid ?? it.fid ?? "") : String(it.fid ?? ownCid ?? "");
  const epoch = Number(it.te ?? it.tp ?? (typeof it.t === "number" ? it.t : 0));
  const sha1 = it.sha ?? it.sha1;
  return {
    id,
    cid: isDir ? ownCid : undefined,
    fid: hasFid ? String(it.fid) : undefined,
    pid,
    name: String(it.n ?? it.file_name ?? ""),
    size: Number(it.s ?? it.size ?? it.file_size ?? 0),
    sha1: sha1 ? sha1 : undefined,
    ico: it.ico ?? undefined,
    isDir,
    mtime: Number.isFinite(epoch) && epoch > 0 ? epoch : undefined,
    ctime: Number(it.c ?? it.tp ?? 0) || undefined,
    pickcode: it.pc ?? it.pickcode,
  };
}

/** 把 `unknown` 收敛成对象；非对象一律返回空对象。 */
function asObject(value: unknown): Raw115Object {
  return value !== null && typeof value === "object" ? (value as Raw115Object) : {};
}

/** 把 `unknown` 收敛成对象数组。 */
function asArray(value: unknown): Raw115Object[] {
  return Array.isArray(value) ? (value as Raw115Object[]) : [];
}

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
  private parseJson(res: HttpResponse): Raw115Envelope {
    if (res.json === undefined) {
      throw new P115Error(
        "session_expired",
        "115 返回登录页：会话或 acw_tc 已失效，请重新扫码登录。",
        res.text.slice(0, 400),
      );
    }
    return asObject(res.json);
  }

  /** 统一请求：带 cookie、解析 JSON、把异常归一化成 P115Error。 */
  private async request(
    path: string,
    method: "GET" | "POST",
    fields: Record<string, string | number | undefined> = {},
  ): Promise<Raw115Object> {
    const body = await this.requestRaw(path, method, fields);
    return asObject(body.data ?? body);
  }

  /** 同 request，但返回**未拆壳**的完整响应体（需要 `count` / `path` 这类外层字段时用）。 */
  private async requestRaw(
    path: string,
    method: "GET" | "POST",
    fields: Record<string, string | number | undefined> = {},
  ): Promise<Raw115Envelope> {
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
    if (isFailedEnvelope(body)) {
      throw new P115Error(
        classifyP115Error(describeEnvelopeError(body)),
        describeEnvelopeError(body),
        JSON.stringify(body).slice(0, 400),
      );
    }
    return body;
  }

  // ------------------------------------------------------------ 只读
  //
  // 端点均按 p115client 的 Web 实现逐条核对过（2026-11-23）：
  //   列目录  GET  https://webapi.115.com/files?aid=1&cid=&limit=&offset=&count_folders=1&record_open_time=1&show_dir=1
  //   账号    GET  https://webapi.115.com/user/info
  //   容量    GET  https://115.com/index.php?ct=ajax&ac=get_storage_info
  //   搜索    GET  https://webapi.115.com/files/search?aid=1&cid=0&limit=1150&offset=0&show_dir=1&search_value=
  //   元数据  GET  https://webapi.115.com/files/get_info?file_id=
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
    const body = await this.requestRaw(`/files?${qs.toString()}`, "GET");
    const list = asArray(body.data) as Raw115Entry[];
    const entries = list.map(mapEntry);
    const total = Number(body.count ?? entries.length);
    return {
      entries,
      total,
      hasMore: offset + entries.length < total,
      // `/files` 会在 path 里回带从根到当前目录的完整链路，UI 面包屑直接可用
      path: Array.isArray(body.path)
        ? body.path.map((p) => ({ cid: String(p.cid ?? "0"), name: String(p.name ?? "") }))
        : undefined,
    };
  }

  /** 容量信息（115.com 的 get_storage_info，返回按存储类型分组的 total/used）。 */
  async quota(): Promise<P115Quota> {
    const res = await this.transport({
      url: "https://115.com/index.php?ct=ajax&ac=get_storage_info",
      method: "GET",
      headers: this.headers(),
    });
    const body = this.parseJson(res);
    const data = asObject(body.data ?? body);
    const main = asObject(data["1"] ?? data["0"]);
    const total = Number(main.total ?? data.total ?? 0);
    const used = Number(main.used ?? data.used ?? 0);
    return { total, used, free: Math.max(0, total - used) };
  }

  /** 账号信息（含风控标记 violation_info / checking_info）。 */
  async account(): Promise<{ user_id: string; user_name: string; violation_info: unknown[]; checking_info: unknown[] }> {
    const data = await this.request("/user/info", "GET");
    const violation = data.violation_info;
    const checking = data.checking_info;
    return {
      user_id: rawStr(data.user_id ?? data.userId),
      user_name: rawStr(data.user_name ?? data.userName),
      violation_info: Array.isArray(violation) ? violation : [],
      checking_info: Array.isArray(checking) ? checking : [],
    };
  }

  /** 按名称搜索（115 web 搜索接口，GET + search_value；`online=false` 时只搜未缓存的？不，保持服务端行为）。 */
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
    const raw = Array.isArray(data) ? data : (data.data ?? data.list ?? []);
    const list = asArray(raw) as Raw115Entry[];
    return list.map(mapEntry);
  }

  /**
   * 单个文件 / 目录的元数据：GET /files/get_info?file_id=
   *
   * 这是 p115client `fs_file` 的 Web 端点。2026-11-23 实测：
   *  - 目录传 cid、文件传 fid，都返回 `data: [ {...} ]`；
   *  - 抢救性提示：文件进回收站后此接口就不返回它了。
   */
  async stat(id: string): Promise<P115Entry | null> {
    const data = await this.request(`/files/get_info?file_id=${encodeURIComponent(id)}`, "GET");
    const raw = Array.isArray(data) ? data : (data.data ?? []);
    const list = asArray(raw) as Raw115Entry[];
    const first = list[0];
    return first ? mapEntry(first) : null;
  }

  // ------------------------------------------------------------ 写操作（调用方必须先过 Policy）

  /**
   * 建目录：POST /files/add {cname, pid}
   *
   * 实测响应形如 `{state:true, cid:"<新目录 cid>", cname:"..."}`；
   * 拿不到 cid 时返回 null，调用方需自行回查（隔离目录就是这么做的）。
   */
  async mkdir(pid: string, name: string): Promise<{ cid: string } | null> {
    const body = await this.requestRaw("/files/add", "POST", { cname: name, pid: String(pid) });
    const data = asObject(body.data ?? body);
    const cid = data.cid ?? data.file_id;
    return cid ? { cid: rawStr(cid) } : null;
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
