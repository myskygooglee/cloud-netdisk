/**
 * 115 扫码登录（TS 实现）。
 *
 * 流程（按 p115client 的 Web 实现逐条核对，2026-11-23）：
 *  1) 取二维码   GET  https://qrcodeapi.115.com/api/1.0/{app}/1.0/token/
 *                 → data = { uid, time, sign, qrcode }
 *  2) 轮询状态   GET  https://qrcodeapi.115.com/get/status/?uid=&time=&sign=
 *                 → data.status: 0=等待扫码 1=已扫码 2=已登录 -1=已过期 -2=已取消
 *  3) 取 Cookie   POST https://qrcodeapi.115.com/app/1.0/{app}/1.0/login/qrcode/  {account: uid}
 *                 → data.cookie = 完整 Cookie 串
 *
 * ⚠️ 关键：**取码与取结果必须用同一个 app**。
 *    之前用 alipaymini 造码、却按 alipaymini 取结果仍一直 waiting —— 根因是
 *    token 用的是默认 web 通道，与结果通道不一致。115 手机 App 扫码请用 app="web"。
 */

import { requestUrl } from "obsidian";
import { P115Error, classifyP115Error } from "./errors";
import { cookiesFromSetCookie, HttpResponse, Transport, httpTransport, pickAcwTc } from "./client";
import { describeEnvelopeError, isFailedEnvelope, rawStr } from "./types";
import type { Raw115Envelope, Raw115Object } from "./types";

const QRCODE_API = "https://qrcodeapi.115.com";

export type QrStatus = "waiting" | "scanned" | "signed_in" | "expired" | "canceled" | "unknown";

export interface QrSession {
  app: string;
  uid: string;
  time: number;
  sign: string;
  /** 扫码链接（115 App 扫一扫可直接打开）；115 不给图片 URL，只给这个 */
  qrcode: string;
  /** 同上，语义化别名 */
  scanUrl: string;
  /**
   * token 请求时 115 下发的 `acw_tc`。
   *
   * 2026-11-23 实测：`/app/1.0/{app}/1.0/login/qrcode/` 会校验这个粘性 cookie，
   * 不带它取结果会返回 `errno=40101017 老乡验证失败！`（**未扫码时也会这样**）。
   * 隧道里带不带都没用 —— 关键是它必须是**同一次 token 请求拿到的那一个**。
   */
  acwTc?: string;
}

export interface QrLoginOptions {
  transport?: Transport;
  /** 二进制传输（取二维码图片用）；默认走 Obsidian requestUrl 的 arrayBuffer */
  binaryTransport?: (url: string, headers: Record<string, string>) => Promise<HttpResponse>;
  /** 扫码通道：115 手机 App 用 "web" */
  app?: string;
}

/** 默认二进制传输：用 `requestUrl` 拿 ArrayBuffer 再转 base64。 */
const defaultBinaryTransport = async (url: string, headers: Record<string, string>): Promise<HttpResponse> => {
  const res = await requestUrl({ url, method: "GET", headers, throw: false });
  const buf = res.arrayBuffer;
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const base64 = btoa(binary);
  return {
    status: res.status,
    text: `<${bytes.length} bytes>`,
    base64,
    contentType: res.headers?.["content-type"] ?? res.headers?.["Content-Type"],
  };
};

export class QrLogin {
  private readonly transport: Transport;
  private readonly binaryTransport: (url: string, headers: Record<string, string>) => Promise<HttpResponse>;
  readonly app: string;

  constructor(opts: QrLoginOptions = {}) {
    this.transport = opts.transport ?? httpTransport;
    this.binaryTransport = opts.binaryTransport ?? defaultBinaryTransport;
    this.app = opts.app ?? "web";
  }

  private async get(url: string, session?: QrSession): Promise<{ data: Raw115Object; res: HttpResponse }> {
    let res: HttpResponse;
    const headers: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
      Referer: "https://115.com/",
    };
    if (session?.acwTc) headers.Cookie = `acw_tc=${session.acwTc}`;
    try {
      res = await this.transport({ url, method: "GET", headers });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new P115Error(classifyP115Error(raw), raw, raw);
    }
    if (res.json === undefined) {
      throw new P115Error("unknown", "扫码接口返回了非 JSON 内容", res.text.slice(0, 300));
    }
    const body = res.json as Raw115Envelope;
    if (isFailedEnvelope(body)) {
      const msg = describeEnvelopeError(body);
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 300));
    }
    const data = body.data;
    return { data: data !== null && typeof data === "object" ? (data as Raw115Object) : {}, res };
  }

  /** 第 1 步：取二维码。 */
  async start(): Promise<QrSession> {
    const { data, res } = await this.get(`${QRCODE_API}/api/1.0/${this.app}/1.0/token/`);
    const uid = rawStr(data.uid);
    if (!uid) throw new P115Error("unknown", "115 未返回二维码 uid", JSON.stringify(data).slice(0, 300));
    const raw = rawStr(data.qrcode);
    // 115 的 token 接口**不返回图片**，`qrcode` 字段是 `https://115.com/scan/dg-<uid>` 网页链接。
    // 真正的图片要走 /api/1.0/{app}/1.0/qrcode?uid=，见 fetchImage()。
    const qrcode = raw.startsWith("http") || raw.startsWith("data:") ? raw : `https://115.com/scan/dg-${uid}`;
    return {
      app: this.app,
      uid,
      time: Number(data.time ?? 0),
      sign: rawStr(data.sign),
      qrcode,
      scanUrl: `https://115.com/scan/dg-${uid}`,
      acwTc: pickAcwTc(res.headers?.["set-cookie"]),
    };
  }

  /**
   * 取二维码**图片**（PNG → data URI）。
   *
   * 2026-11-23 实测：`GET /api/1.0/{app}/1.0/qrcode?uid=<uid>` 返回
   * `Content-Type: image/png`，约 500 字节（200×200 的二维码）。
   * 直接把 token 里的 `qrcode`（那是个网页链接）塞进 `<img src>` 会显示裂图 ——
   * 这就是设置页二维码显示不出来的根因。
   */
  async fetchImage(session: QrSession): Promise<string> {
    const url = `${QRCODE_API}/api/1.0/${this.app}/1.0/qrcode?uid=${encodeURIComponent(session.uid)}`;
    let res: HttpResponse;
    try {
      res = await this.binaryTransport(url, {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
        Referer: "https://115.com/",
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new P115Error(classifyP115Error(raw), raw, raw);
    }
    if (!res.base64) {
      throw new P115Error("unknown", "二维码图片接口未返回二进制内容", res.text.slice(0, 200));
    }
    const mime = res.contentType?.startsWith("image/") ? res.contentType : "image/png";
    return `data:${mime};base64,${res.base64}`;
  }

  /** 第 2 步：轮询状态。 */
  async status(session: QrSession): Promise<{ status: QrStatus; raw: number }> {
    const qs = new URLSearchParams({
      uid: session.uid,
      time: String(session.time),
      sign: session.sign,
    });
    const { data } = await this.get(`${QRCODE_API}/get/status/?${qs.toString()}`, session);
    const raw = Number(data.status ?? 0);
    const status: QrStatus =
      raw === 0 ? "waiting" : raw === 1 ? "scanned" : raw === 2 ? "signed_in" : raw === -1 ? "expired" : raw === -2 ? "canceled" : "unknown";
    return { status, raw };
  }

  /**
   * 第 3 步：取回 Cookie 串。
   *
   * ⚠️ 必须带上 token 请求下发的 `acw_tc`（115 的 WAF 粘性 cookie）。
   * 少了它会返回 `errno=40101017 老乡验证失败！` —— 而这个响应是 `state: 0`（数字），
   * 旧代码只判 `state === false`，于是把它当成成功，最后报成
   * 「扫码成功但未返回 Cookie」（2026-11-23 用户实测踩到）。
   */
  async finish(session: QrSession): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
      Referer: "https://115.com/",
      Origin: "https://115.com",
    };
    if (session.acwTc) headers.Cookie = `acw_tc=${session.acwTc}`;
    const res = await this.transport({
      url: `${QRCODE_API}/app/1.0/${this.app}/1.0/login/qrcode/`,
      method: "POST",
      headers,
      body: `account=${encodeURIComponent(session.uid)}`,
    });
    if (res.json === undefined) {
      throw new P115Error("unknown", "扫码结果返回了非 JSON 内容", res.text.slice(0, 300));
    }
    const body = res.json as Raw115Envelope;
    if (isFailedEnvelope(body)) {
      const msg = describeEnvelopeError(body);
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 300));
    }
    const data = body.data;
    const payload = data !== null && typeof data === "object" ? (data as Raw115Object) : {};

    // ① 老格式：响应体直接给 data.cookie（一整串）
    const fromBody = rawStr(payload.cookie);

    // ② 新格式（2026-11-23 起）：响应体只有用户资料，Cookie 走多条 Set-Cookie
    const fromHeaders = cookiesFromSetCookie(res.headers?.["set-cookie"]);

    // ③ 兜底：响应体里零散给了 UID / CID / SEID / KID 等字段（不同端实现不一）
    const scattered: string[] = [];
    for (const name of ["UID", "CID", "SEID", "KID"]) {
      const v = rawStr(payload[name]) || rawStr(payload[name.toLowerCase()]);
      if (v) scattered.push(`${name}=${v}`);
    }
    const fromFields = scattered.join("; ");

    const cookie = [fromBody, fromHeaders, fromFields].filter(Boolean).join("; ");
    if (!cookie) {
      // 关键诊断：把 115 到底给了什么原样带出来，别再让用户猜
      const user = rawStr(payload.user_name) || rawStr(payload.user_id) || "?";
      const headerKeys = Object.keys(res.headers ?? {});
      const rawSetCookie = res.headers?.["set-cookie"] ?? "（响应头里没有 Set-Cookie）";
      const bodyKeys = Object.keys(payload).join(", ") || "（data 为空）";
      throw new P115Error(
        "unknown",
        [
          `115 返回了用户信息（${user}）但没有下发 Cookie。`,
          `这通常是 115 登录接口变更，请把这整段发给开发者。`,
          `响应头字段：${headerKeys.join(", ") || "（空）"}`,
          `data 字段：${bodyKeys}`,
          `Set-Cookie：${rawSetCookie.slice(0, 400)}`,
        ].join("\n"),
        JSON.stringify({ body: body, setCookie: rawSetCookie, headerKeys }).slice(0, 800),
      );
    }
    return cookie;
  }
}
