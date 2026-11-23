/**
 * agent 可见的工具定义。
 *
 * 硬约束（AGENTS.md 第一节）：每次调用 115 工具只处理 1 个文件或 1 个目录。
 * 因此这里所有写工具的 schema **只接受单数参数**，不接受数组。
 */

import { READ_ONLY_HINT, WRITE_HINT } from "./guidance";

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  params: ToolParam[];
  /** 写操作标记（供 UI 提示与策略计数） */
  mutating?: boolean;
}

export const TOOLS: ToolDef[] = [
  {
    name: "list_dir",
    description: "列出 115 云盘某个目录的内容（只读）。",
    params: [
      { name: "cid", type: "string", description: "目录 cid，根目录为 0", required: false },
    ],
  },
  {
    name: "stat",
    description: "获取单个文件或目录的元数据（大小、sha1、mtime）。",
    params: [
      { name: "cid_or_fid", type: "string", description: "目标 cid 或 fid", required: true },
    ],
  },
  {
    name: "search",
    description: "按名称搜索 115 云盘文件（只读）。",
    params: [
      { name: "query", type: "string", description: "关键词", required: true },
      { name: "page", type: "number", description: "页码，默认 1", required: false },
    ],
  },
  {
    name: "quota",
    description: "读取 115 容量（总/已用/剩余）。",
    params: [],
  },
  {
    name: "health",
    description: "检查 115 会话健康度（账号接口 + 文件接口同时探测）。",
    params: [],
  },
  {
    name: "mkdir",
    description: "在指定目录下创建**一个**新目录。",
    mutating: true,
    params: [
      { name: "pid", type: "string", description: "父目录 cid", required: true },
      { name: "name", type: "string", description: "目录名", required: true },
    ],
  },
  {
    name: "rename",
    description: "重命名**一个**文件或目录。",
    mutating: true,
    params: [
      { name: "fid", type: "string", description: "目标 fid", required: true },
      { name: "new_name", type: "string", description: "新名称", required: true },
    ],
  },
  {
    name: "move",
    description: "移动**一个**文件或目录到目标目录（不可撤销，需谨慎）。",
    mutating: true,
    params: [
      { name: "fid", type: "string", description: "目标 fid", required: true },
      { name: "to_pid", type: "string", description: "目标父目录 cid", required: true },
    ],
  },
  {
    name: "quarantine",
    description:
      "把**一个**视频/归档文件移动到隔离目录 `_去重待删_YYYYMMDD/`（可逆）。删除类操作默认走这个工具。",
    mutating: true,
    params: [
      { name: "fid", type: "string", description: "目标 fid", required: true },
      { name: "name", type: "string", description: "文件名（用于判断类型）", required: true },
      { name: "size", type: "number", description: "文件大小（字节）", required: false },
    ],
  },
  {
    name: "delete_small_garbage",
    description:
      "删除**一个**白名单小垃圾文件（jpg/png/url/txt/html/gif/torrent/mht 等）。其它类型一律拒绝，请改用 quarantine。",
    mutating: true,
    params: [
      { name: "fid", type: "string", description: "目标 fid", required: true },
      { name: "name", type: "string", description: "文件名（用于判断类型）", required: true },
      { name: "size", type: "number", description: "文件大小（字节）", required: false },
    ],
  },
  {
    name: "confirm_writes",
    description: "确认继续写操作（用于连续 3 次写操作后的停顿确认）。",
    mutating: true,
    params: [],
  },
  {
    name: "preflight",
    description: "开工前必查：会话 / 风控 / 容量 / 计划清单时效。",
    params: [],
  },
];

/** 转为 MCP tools/list 需要的 JSON Schema。 */
export function toolSchemas(): Array<{
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}> {
  return TOOLS.map((t) => {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const p of t.params) {
      properties[p.name] = { type: p.type, description: p.description, ...(p.enum ? { enum: p.enum } : {}) };
      if (p.required) required.push(p.name);
    }
    return {
      name: t.name,
      // 描述里带上安全提示，让 agent 自己就知道红线（只改文案，不改行为）
      description: `${t.description} ${t.mutating ? WRITE_HINT : READ_ONLY_HINT}`,
      inputSchema: {
        type: "object" as const,
        properties,
        ...(required.length ? { required } : {}),
      },
    };
  });
}
