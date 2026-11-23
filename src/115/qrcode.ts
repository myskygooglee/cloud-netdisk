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

import { P115Error, classifyP115Error } from "./errors";
import { HttpResponse, Transport, httpTransport } from "./client";

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
  /** 扫码通道：115 手机 App 用 "web" */
  app?: string;
}

export class QrLogin {
  private readonly transport: Transport;
  readonly app: string;

  constructor(opts: QrLoginOptions = {}) {
    this.transport = opts.transport ?? httpTransport;
    this.app = opts.app ?? "web";
  }

  private async get(url: string): Promise<any> {
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
    const body = res.json as { state?: boolean; error?: string; errno?: number; data?: any };
    if (body.state === false) {
      const msg = `${body.error ?? "unknown error"} errno=${body.errno ?? "?"}`;
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 300));
    }
    return body.data ?? body;
  }

  /** 第 1 步：取二维码。 */
  async start(): Promise<QrSession> {
    const data = await this.get(`${QRCODE_API}/api/1.0/${this.app}/1.0/token/`);
    const uid = String(data?.uid ?? "");
    if (!uid) throw new P115Error("unknown", "115 未返回二维码 uid", JSON.stringify(data).slice(0, 300));
    const raw = String(data?.qrcode ?? "");
    const qrcode = raw.startsWith("http") || raw.startsWith("data:") ? raw : `https://115.com/scan/dg-${uid}`;
    return {
      app: this.app,
      uid,
      time: Number(data?.time ?? 0),
      sign: String(data?.sign ?? ""),
      qrcode,
      scanUrl: `https://115.com/scan/dg-${uid}`,
    };
  }

  /** 第 2 步：轮询状态。 */
  async status(session: QrSession): Promise<{ status: QrStatus; raw: number }> {
    const qs = new URLSearchParams({
      uid: session.uid,
      time: String(session.time),
      sign: session.sign,
    });
    const data = await this.get(`${QRCODE_API}/get/status/?${qs.toString()}`);
    const raw = Number(data?.status ?? 0);
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
    const body = res.json as { state?: boolean; error?: string; errno?: number; data?: any };
    if (body.state === false) {
      const msg = `${body.error ?? "unknown error"} errno=${body.errno ?? "?"}`;
      throw new P115Error(classifyP115Error(msg), msg, JSON.stringify(body).slice(0, 300));
    }
    const cookie = String(body?.data?.cookie ?? "");
    if (!cookie) throw new P115Error("unknown", "扫码成功但未返回 Cookie", JSON.stringify(body).slice(0, 300));
    return cookie;
  }
}
