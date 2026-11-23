/**
 * 扫码登录流程测试（假传输层，不发真实请求）。
 */

import { describe, expect, it } from "vitest";
import { HttpResponse, Transport } from "../src/115/client";
import { QrLogin } from "../src/115/qrcode";

function fakeTransport(responses: Array<any>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  let i = 0;
  const transport: Transport = async (opts) => {
    calls.push({ url: opts.url, method: opts.method, body: opts.body });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    const text = JSON.stringify(payload);
    return { status: 200, text, json: payload } as HttpResponse;
  };
  return { calls, transport };
}

describe("扫码登录", () => {
  it("第一步取二维码：URL 为 /api/1.0/web/1.0/token/", async () => {
    const { calls, transport } = fakeTransport([
      { state: true, data: { uid: "abc123", time: 1700000000, sign: "SIG", qrcode: "https://115.com/scan/dg-abc123" } },
    ]);
    const session = await new QrLogin({ transport, app: "web" }).start();
    expect(calls[0].url).toBe("https://qrcodeapi.115.com/api/1.0/web/1.0/token/");
    expect(session.uid).toBe("abc123");
    expect(session.sign).toBe("SIG");
    expect(session.scanUrl).toBe("https://115.com/scan/dg-abc123");
  });

  it("第二步轮询状态：URL 带 uid/time/sign，状态码映射正确", async () => {
    const { calls, transport } = fakeTransport([
      { state: true, data: { status: 1 } },
      { state: true, data: { status: 2 } },
    ]);
    const qr = new QrLogin({ transport, app: "web" });
    const session = { app: "web", uid: "u", time: 1, sign: "s", qrcode: "q", scanUrl: "u" };
    const s1 = await qr.status(session);
    expect(s1.status).toBe("scanned");
    const s2 = await qr.status(session);
    expect(s2.status).toBe("signed_in");
    expect(calls[0].url).toContain("uid=u");
    expect(calls[0].url).toContain("time=1");
    expect(calls[0].url).toContain("sign=s");
  });

  it("第三步取 Cookie：POST /app/1.0/web/1.0/login/qrcode/ 且 body 为 account=uid", async () => {
    const { calls, transport } = fakeTransport([
      { state: true, data: { cookie: "UID=1; CID=2; SEID=3; KID=4; acw_tc=5" } },
    ]);
    const qr = new QrLogin({ transport, app: "web" });
    const cookie = await qr.finish({ app: "web", uid: "u1", time: 1, sign: "s", qrcode: "q", scanUrl: "u" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://qrcodeapi.115.com/app/1.0/web/1.0/login/qrcode/");
    expect(calls[0].body).toBe("account=u1");
    expect(cookie).toContain("SEID=3");
  });

  it("取码与取结果使用同一 app（web），避免通道错配导致一直 waiting", async () => {
    const { calls, transport } = fakeTransport([{ state: true, data: { uid: "u", time: 1, sign: "s" } }]);
    await new QrLogin({ transport, app: "web" }).start();
    expect(calls[0].url).toContain("/api/1.0/web/1.0/token/");
    expect(calls[0].url).not.toContain("alipaymini");
  });

  it("扫码失败（state=false）抛出可读错误", async () => {
    const { transport } = fakeTransport([{ state: false, error: "IP登录异常", errno: 0 }]);
    await expect(new QrLogin({ transport, app: "web" }).start()).rejects.toThrow(/IP登录异常/);
  });
});
