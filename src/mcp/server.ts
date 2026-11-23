/**
 * 本地 MCP 服务端（Streamable HTTP，JSON-RPC 2.0）。
 *
 * 目的：让 Obsidian 里的 agent（Copilot）把本插件当作一个 MCP server 使用。
 * 安全：只监听 127.0.0.1，且每个请求都要带启动时生成的令牌。
 */

import { createServer, IncomingMessage, Server, ServerResponse } from "http";
import { randomBytes } from "crypto";
import { ToolDispatcher } from "./dispatch";
import { toolSchemas } from "./tools";

export interface McpServerOptions {
  dispatcher: ToolDispatcher;
  /** 端口范围，0 表示自动 */
  port?: number;
  portRange?: [number, number];
  /** 固定令牌（持久化时传入，避免重启后 Copilot 配置失效） */
  token?: string;
  onLog?: (msg: string) => void;
}

export interface McpServerInfo {
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: any;
}

const PROTOCOL_VERSION = "2024-11-05";

export async function startMcpServer(opts: McpServerOptions): Promise<McpServerInfo> {
  const token = opts.token && opts.token.trim().length >= 16 ? opts.token.trim() : randomBytes(24).toString("hex");
  const log = opts.onLog ?? (() => undefined);
  const range: [number, number] = opts.portRange ?? [7300, 7399];

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    // 仅本机 + 令牌校验
    const remote = req.socket.remoteAddress ?? "";
    if (!remote.includes("127.0.0.1") && !remote.includes("::1")) {
      res.writeHead(403).end("forbidden");
      return;
    }
    const provided = (req.headers["x-115-token"] as string) || (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (provided !== token) {
      res.writeHead(401).end("unauthorized");
      return;
    }

    if (req.method === "GET") {
      // SSE 通道（本实现用 POST-only 的简化模式）
      res.writeHead(405, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "use POST" }));
      return;
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let payload: JsonRpcRequest | JsonRpcRequest[];
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "parse error" } }));
        return;
      }
      const requests = Array.isArray(payload) ? payload : [payload];
      const responses: any[] = [];
      for (const reqObj of requests) {
        const result = await handleRpc(reqObj, opts.dispatcher);
        if (result !== undefined) responses.push(result);
      }
      if (!responses.length) {
        res.writeHead(202).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(Array.isArray(payload) ? responses : responses[0]));
    });
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err) => {
      log(`MCP 处理异常：${(err as Error).message}`);
      try {
        res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: String(err) } }));
      } catch {
        /* ignore */
      }
    });
  });

  const port = await listen(server, opts.port, range);
  const url = `http://127.0.0.1:${port}/mcp`;
  log(`MCP 服务已启动：${url}`);
  return {
    port,
    token,
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function listen(server: Server, preferred?: number, range: [number, number] = [7300, 7399]): Promise<number> {
  const candidates = preferred ? [preferred, ...rangeFilter(range, preferred)] : rangeFilter(range);
  let lastErr: unknown = null;
  for (const port of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return port;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`无法在端口范围内启动 MCP 服务：${String(lastErr)}`);
}

function rangeFilter(range: [number, number], exclude?: number): number[] {
  const out: number[] = [];
  for (let p = range[0]; p <= range[1]; p++) if (p !== exclude) out.push(p);
  return out;
}

export async function handleRpc(req: JsonRpcRequest, dispatcher: ToolDispatcher): Promise<any> {
  const base = { jsonrpc: "2.0", id: req.id ?? null };
  switch (req.method) {
    case "initialize":
      return {
        ...base,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "obsidian-115", version: "0.1.0" },
        },
      };
    case "notifications/initialized":
      return undefined;
    case "ping":
      return { ...base, result: {} };
    case "tools/list":
      return { ...base, result: { tools: toolSchemas() } };
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, any>;
      const result = await dispatcher.call(name, args);
      return { ...base, result };
    }
    default:
      return { ...base, error: { code: -32601, message: `method not found: ${req.method}` } };
  }
}
