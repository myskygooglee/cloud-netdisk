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

  it("state 为数字 0 也算失败（这是「老乡验证失败」的真实形态）", async () => {
    const { transport } = fakeTransport([
      { state: 0, error: "老乡验证失败！", errno: 40101017, message: "老乡验证失败！", code: 40101017 },
    ]);
    const qr = new QrLogin({ transport, app: "web" });
    // 取结果接口收到 state:0 时必须抛错，不能当成「成功但没 cookie」
    await expect(
      qr.finish({ app: "web", uid: "u", time: 1, sign: "s", qrcode: "q", scanUrl: "u" }),
    ).rejects.toThrow(/老乡验证失败/);
  });

  it("finish 会带上 token 请求下发的 acw_tc（否则 115 报 40101017）", async () => {
    const calls: Array<{ headers?: Record<string, string> }> = [];
    const transport: Transport = async (opts) => {
      calls.push({ headers: opts.headers });
      const payload = { state: 1, data: { cookie: "UID=1; SEID=2" } };
      return { status: 200, text: JSON.stringify(payload), json: payload } as HttpResponse;
    };
    const qr = new QrLogin({ transport, app: "web" });
    await qr.finish({
      app: "web",
      uid: "u",
      time: 1,
      sign: "s",
      qrcode: "q",
      scanUrl: "u",
      acwTc: "ACW123",
    });
    expect(calls[0].headers?.Cookie).toBe("acw_tc=ACW123");
  });

  it("start 会从 Set-Cookie 里抓出 acw_tc 存进 session", async () => {
    const transport: Transport = async () => {
      const payload = { state: 1, data: { uid: "U9", time: 5, sign: "S9", qrcode: "https://115.com/scan/dg-U9" } };
      return {
        status: 200,
        text: JSON.stringify(payload),
        json: payload,
        headers: { "set-cookie": "acw_tc=ABC987;path=/;HttpOnly;Max-Age=1800" },
      } as HttpResponse;
    };
    const session = await new QrLogin({ transport, app: "web" }).start();
    expect(session.acwTc).toBe("ABC987");
  });

  it("二维码图片走 /api/1.0/{app}/1.0/qrcode?uid=，转成 data URI", async () => {
    const seen: string[] = [];
    const binaryTransport = async (url: string) => {
      seen.push(url);
      return {
        status: 200,
        text: "<531 bytes>",
        base64: "iVBORw0KGgo=",
        contentType: "image/png",
      } as HttpResponse;
    };
    const qr = new QrLogin({ transport: fakeTransport([{ state: true, data: {} }]).transport, binaryTransport, app: "web" });
    const uri = await qr.fetchImage({ app: "web", uid: "U1", time: 1, sign: "s", qrcode: "q", scanUrl: "u" });
    expect(seen[0]).toBe("https://qrcodeapi.115.com/api/1.0/web/1.0/qrcode?uid=U1");
    expect(uri).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("图片接口没给二进制时报错（不会静默裂图）", async () => {
    const binaryTransport = async () =>
      ({ status: 200, text: "not-an-image" }) as HttpResponse;
    const qr = new QrLogin({ transport: fakeTransport([{ state: true, data: {} }]).transport, binaryTransport });
    await expect(
      qr.fetchImage({ app: "web", uid: "U", time: 1, sign: "s", qrcode: "q", scanUrl: "u" }),
    ).rejects.toThrow(/二进制/);
  });
});
