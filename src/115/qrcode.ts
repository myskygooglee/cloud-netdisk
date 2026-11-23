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
import { HttpResponse, Transport, httpTransport } from "./client";
import { rawStr } from "./types";
import type { Raw115Envelope, Raw115Object } from "./types";

const QRCODE_API = "https://qrcodeapi.115.com";

export type QrStatus = "waiting" | "scanned" | "signed_in" | "expired" | "canceled" | "unknown";

export interface QrSession {
  app: string;
  uid: string;
  time: number;
  sign: string;
  /** 二维码图片（data URI 或 https 链接），115 返回 base64 PNG 时会带 `data:image/png;base64,` 前缀 */
  qrcode: string;
  /** 扫码链接（115 App 扫一扫可直接打开） */
  scanUrl: string;
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

  private async get(url: string): Promise<Raw115Object> {
    let res: HttpResponse;
    try {
      res = await this.transport({
        url,
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
          Referer: "https://115.com/",
        },
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw new P115Error(classifyP115Error(raw), raw, raw);
    }
    if (res.json === undefined) {
      throw new P115Error("unknown", "扫码接口返回了非 JSON 内容", res.text.slice(0, 300));
    }
    const body = res.json as Raw115Envelope;
    if (body.state === false) {
      const msg = `${body.error ?? "unknown error"} errno=${body.errno ?? "?"}`;
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 300));
    }
    const data = body.data;
    return data !== null && typeof data === "object" ? (data as Raw115Object) : {};
  }

  /** 第 1 步：取二维码。 */
  async start(): Promise<QrSession> {
    const data = await this.get(`${QRCODE_API}/api/1.0/${this.app}/1.0/token/`);
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
    const data = await this.get(`${QRCODE_API}/get/status/?${qs.toString()}`);
    const raw = Number(data.status ?? 0);
    const status: QrStatus =
      raw === 0 ? "waiting" : raw === 1 ? "scanned" : raw === 2 ? "signed_in" : raw === -1 ? "expired" : raw === -2 ? "canceled" : "unknown";
    return { status, raw };
  }

  /** 第 3 步：取回 Cookie 串。 */
  async finish(session: QrSession): Promise<string> {
    const res = await this.transport({
      url: `${QRCODE_API}/app/1.0/${this.app}/1.0/login/qrcode/`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) 115Browser/36.2.28",
        Referer: "https://115.com/",
      },
      body: `account=${encodeURIComponent(session.uid)}`,
    });
    if (res.json === undefined) {
      throw new P115Error("unknown", "扫码结果返回了非 JSON 内容", res.text.slice(0, 300));
    }
    const body = res.json as Raw115Envelope;
    if (body.state === false) {
      const msg = `${body.error ?? "unknown error"} errno=${body.errno ?? "?"}`;
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 300));
    }
    const data = body.data;
    const payload =
      data !== null && typeof data === "object" ? (data as Raw115Object) : {};
    const cookie = rawStr(payload.cookie);
    if (!cookie) throw new P115Error("unknown", "扫码成功但未返回 Cookie", JSON.stringify(body).slice(0, 300));
    return cookie;
  }
}
