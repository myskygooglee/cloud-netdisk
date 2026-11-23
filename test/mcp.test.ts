/**
 * MCP JSON-RPC 层单测（不启动 HTTP，只测协议处理）。
 */

import { describe, expect, it } from "vitest";
import { handleRpc } from "../src/mcp/server";

const fakeDispatcher = {
  call: async (name: string, args: any) => {
    if (name === "boom") throw new Error("x");
    return { content: [{ type: "text", text: `called ${name} ${JSON.stringify(args)}` }] };
  },
} as any;

describe("MCP JSON-RPC", () => {
  it("initialize 返回协议版本与 serverInfo", async () => {
    const res = (await handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, fakeDispatcher)) as any;
    expect(res.result.protocolVersion).toBeTruthy();
    expect(res.result.serverInfo.name).toBe("cloud-115");
    expect(res.result.capabilities.tools).toBeTruthy();
  });

  it("tools/list 返回工具清单，且写工具只收单数参数", async () => {
    const res = (await handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, fakeDispatcher)) as any;
    const tools = res.result.tools;
    expect(tools.length).toBeGreaterThan(5);
    const listDir = tools.find((t: any) => t.name === "list_dir");
    expect(listDir.inputSchema.properties.cid.type).toBe("string");
    const rename = tools.find((t: any) => t.name === "rename");
    expect(rename.inputSchema.properties.fid.type).toBe("string");
    expect(Object.values(rename.inputSchema.properties as any).every((p: any) => p.type !== "array")).toBe(true);
  });

  it("tools/call 透传参数给 dispatcher", async () => {
    const res = (await handleRpc(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_dir", arguments: { cid: "123" } } },
      fakeDispatcher,
    )) as any;
    expect(res.result.content[0].text).toContain("called list_dir");
    expect(res.result.content[0].text).toContain("123");
  });

  it("notifications/initialized 不返回内容", async () => {
    const res = await handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, fakeDispatcher);
    expect(res).toBeUndefined();
  });

  it("未知方法返回 -32601", async () => {
    const res = (await handleRpc({ jsonrpc: "2.0", id: 4, method: "nope" }, fakeDispatcher)) as any;
    expect(res.error.code).toBe(-32601);
  });
});
