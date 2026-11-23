/**
 * 端点契约测试：断言 URL / 参数与 p115client 的 Web 实现一致（不发真实请求）。
 */

import { describe, expect, it } from "vitest";
import { HttpResponse, P115Client, Transport } from "../src/115/client";

function recorder(responses: Record<string, any> = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const transport: Transport = async (opts) => {
    calls.push({ url: opts.url, method: opts.method, body: opts.body });
    const key = Object.keys(responses).find((k) => opts.url.includes(k));
    const payload = key ? responses[key] : { state: true, data: [] };
    const text = JSON.stringify(payload);
    return { status: 200, text, json: payload } as HttpResponse;
  };
  return { calls, transport };
}

function client(transport: Transport) {
  return new P115Client({ transport, getCookie: () => "UID=1; SEID=2" });
}

describe("端点契约", () => {
  it("列目录：GET webapi.115.com/files 且带 cid/limit/offset/count_folders", async () => {
    const { calls, transport } = recorder({ "/files?": { state: true, data: [] } });
    await client(transport).listDir("123", 0, 100);
    const c = calls[0];
    expect(c.method).toBe("GET");
    expect(c.url).toContain("https://webapi.115.com/files?");
    expect(c.url).toContain("cid=123");
    expect(c.url).toContain("limit=100");
    expect(c.url).toContain("offset=0");
    expect(c.url).toContain("count_folders=1");
    expect(c.url).toContain("show_dir=1");
  });

  it("账号：GET webapi.115.com/user/info，并解析风控字段", async () => {
    const { calls, transport } = recorder({
      "/user/info": {
        state: true,
        data: { user_id: "8312294", user_name: "myskygoogle", violation_info: [], checking_info: [] },
      },
    });
    const acc = await client(transport).account();
    expect(calls[0].url).toContain("https://webapi.115.com/user/info");
    expect(acc.user_name).toBe("myskygoogle");
    expect(acc.violation_info).toEqual([]);
  });

  it("容量：GET 115.com/index.php?ct=ajax&ac=get_storage_info，并解析 total/used", async () => {
    const { calls, transport } = recorder({
      "get_storage_info": { state: true, data: { "1": { total: 1000, used: 400 } } },
    });
    const q = await client(transport).quota();
    expect(calls[0].url).toContain("115.com/index.php?ct=ajax&ac=get_storage_info");
    expect(q.total).toBe(1000);
    expect(q.used).toBe(400);
    expect(q.free).toBe(600);
  });

  it("搜索：GET files/search 且参数名是 search_value", async () => {
    const { calls, transport } = recorder({ "/files/search?": { state: true, data: [] } });
    await client(transport).search("测试", 0, 50);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toContain("search_value=");
    expect(calls[0].url).not.toContain("searchval=");
    expect(calls[0].url).toContain("limit=50");
  });

  it("建目录：POST /files/add {cname,pid}", async () => {
    const { calls, transport } = recorder({ "/files/add": { state: true, data: {} } });
    await client(transport).mkdir("0", "测试目录");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("https://webapi.115.com/files/add");
    expect(calls[0].body).toContain("cname=");
    expect(calls[0].body).toContain("pid=0");
  });

  it("重命名：POST /files/batch_rename 且键名是 files_new_name[fid]", async () => {
    const { calls, transport } = recorder({ "/files/batch_rename": { state: true, data: {} } });
    await client(transport).rename("999", "新名字.mp4");
    expect(calls[0].url).toContain("https://webapi.115.com/files/batch_rename");
    expect(calls[0].body).toContain(encodeURIComponent("files_new_name[999]"));
    expect(calls[0].body).toContain(encodeURIComponent("新名字.mp4"));
  });

  it("移动：POST /files/move 且参数是 fid + pid", async () => {
    const { calls, transport } = recorder({ "/files/move": { state: true, data: {} } });
    await client(transport).move("111", "222");
    expect(calls[0].url).toContain("https://webapi.115.com/files/move");
    expect(calls[0].body).toContain("fid=111");
    expect(calls[0].body).toContain("pid=222");
  });

  it("删除：POST /rb/delete（不是 /files/delete）", async () => {
    const { calls, transport } = recorder({ "/rb/delete": { state: true, data: {} } });
    await client(transport).remove("333");
    expect(calls[0].url).toContain("https://webapi.115.com/rb/delete");
    expect(calls[0].url).not.toContain("/files/delete");
  });

  it("元数据：GET /files/get_info?file_id= 且正确映射 fid/sha/s", async () => {
    const { calls, transport } = recorder({
      "/files/get_info": {
        state: true,
        data: [
          {
            fid: "111",
            cid: "222",
            pid: "0",
            n: "a.mp4",
            s: "12345",
            sha: "ABCDEF",
            ico: "mp4",
            fc: 1,
            te: "1795072569",
          },
        ],
      },
    });
    const e = await client(transport).stat("111");
    expect(calls[0].url).toBe("https://webapi.115.com/files/get_info?file_id=111");
    expect(e).toMatchObject({ id: "111", fid: "111", cid: undefined, pid: "222", size: 12345, sha1: "ABCDEF", isDir: false });
    expect(e?.mtime).toBe(1795072569);
  });

  it("目录条目：id 取 cid（目录没有 fid），文件条目 id 取 fid", async () => {
    const transport: Transport = async () => ({
      status: 200,
      text: "{}",
      json: {
        state: true,
        count: 2,
        data: [
          { cid: "777", pid: "0", n: "子目录", fc: 0 },
          { fid: "888", cid: "777", pid: "0", n: "文件.mp4", fc: 1, s: "100", sha: "AA", te: "1700000000" },
        ],
        path: [{ cid: "0", name: "根目录" }],
      },
    });
    const res = await client(transport).listDir("0");
    expect(res.total).toBe(2);
    expect(res.hasMore).toBe(false);
    expect(res.entries[0]).toMatchObject({ id: "777", cid: "777", fid: undefined, pid: "0", isDir: true });
    expect(res.entries[1]).toMatchObject({ id: "888", fid: "888", cid: undefined, pid: "777", isDir: false, size: 100 });
    expect(res.path?.[0].name).toBe("根目录");
  });

  it("建目录：回传新目录 cid", async () => {
    const transport: Transport = async () => ({
      status: 200,
      text: "{}",
      json: { state: true, cid: "555", cname: "新目录" },
    });
    const created = await client(transport).mkdir("0", "新目录");
    expect(created).toEqual({ cid: "555" });
  });

  it("返回 HTML 时判定为会话过期", async () => {
    const transport: Transport = async () => ({ status: 200, text: "<!DOCTYPE html><html>登录</html>" });
    await expect(client(transport).listDir("0")).rejects.toMatchObject({ kind: "session_expired" });
  });

  it("state=false 且含 990001 时按风控分类", async () => {
    const transport: Transport = async () => ({
      status: 200,
      text: JSON.stringify({ state: false, error: "登录超时，请重新登录。", errno: 990001 }),
      json: { state: false, error: "登录超时，请重新登录。", errno: 990001 },
    });
    await expect(client(transport).listDir("0")).rejects.toMatchObject({ kind: "risk_control" });
  });
});
