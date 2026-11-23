/**
 * 引导文案测试：确保 agent 看到的说明包含关键红线（防止以后误删文案）。
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_GUIDE,
  READ_ONLY_BANNER,
  READ_ONLY_HINT,
  WRITE_HINT,
  WRITE_MODE_BANNER,
} from "../src/mcp/guidance";
import { TOOLS, toolSchemas } from "../src/mcp/tools";

describe("引导文案", () => {
  it("只读横幅点名了五个只读工具", () => {
    for (const name of ["list_dir", "stat", "search", "quota", "health"]) {
      expect(READ_ONLY_BANNER).toContain(name);
    }
    expect(READ_ONLY_BANNER).toContain("只读模式");
  });

  it("写模式横幅覆盖全部硬约束关键词", () => {
    for (const kw of ["单次单文件", "串行不并发", "限速", "3 写停", "熔断", "隔离", "回收站"]) {
      expect(WRITE_MODE_BANNER).toContain(kw);
    }
  });

  it("agent 指引给出建议流程与红线", () => {
    for (const kw of ["health()", "preflight()", "quarantine", "confirm_writes", "一次只处理一个", "不要清空回收站"]) {
      expect(AGENT_GUIDE).toContain(kw);
    }
  });

  it("工具描述里带上安全提示", () => {
    const schemas = toolSchemas();
    const listDir = schemas.find((s) => s.name === "list_dir")!;
    expect(listDir.description).toContain(READ_ONLY_HINT.trim());
    const mkdir = schemas.find((s) => s.name === "mkdir")!;
    expect(mkdir.description).toContain(WRITE_HINT.trim());
    expect(mkdir.description).toContain("quarantine");
  });

  it("写工具数量与 mutating 标记一致（闸门可覆盖全部写工具）", () => {
    const mutating = TOOLS.filter((t) => t.mutating).map((t) => t.name);
    expect(mutating.length).toBeGreaterThan(0);
    for (const name of mutating) {
      const schema = toolSchemas().find((s) => s.name === name)!;
      expect(schema.description).toContain("写操作");
    }
  });
});
