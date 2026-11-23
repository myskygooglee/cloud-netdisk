/**
 * 路径探测与失效迁移（2026-11-23 调试新增）。
 *
 * 背景：data.json 里存着 `D:\115-MCP-Server\...`，而实际机器上 Python 侧在
 * `E:\115-MCP-Server\`。loadData 的值会覆盖默认值，于是"看着正常、实际全错"
 * 的路径一直生效 —— 备份按钮找不到脚本、锁目录不存在、清单目录不存在。
 * 这里把「探测」与「自愈」两条规则钉住。
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectServerPaths, detectServerRoot, isForeignServerPath, looksLikeServerRoot, pathExists } from "../src/util/paths";

describe("115-MCP-Server 路径探测", () => {
  it("空目录不算服务器根目录", () => {
    const d = mkdtempSync(join(tmpdir(), "Cloud115-root-"));
    try {
      expect(looksLikeServerRoot(d)).toBe(false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("含 src / scripts / 115-cookies.txt 任一即视为服务器根目录", () => {
    const d = mkdtempSync(join(tmpdir(), "Cloud115-root-"));
    try {
      writeFileSync(join(d, "115-cookies.txt"), "UID=1");
      expect(looksLikeServerRoot(d)).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("环境变量 P115_MCP_SERVER_HOME 优先", () => {
    const d = mkdtempSync(join(tmpdir(), "Cloud115-root-"));
    try {
      writeFileSync(join(d, "scripts"), "");
      const old = process.env.P115_MCP_SERVER_HOME;
      process.env.P115_MCP_SERVER_HOME = d;
      try {
        expect(detectServerRoot()).toBe(d.replace(/\\+$/, ""));
      } finally {
        if (old === undefined) delete process.env.P115_MCP_SERVER_HOME;
        else process.env.P115_MCP_SERVER_HOME = old;
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("探测结果能派生出锁目录 / 清单目录 / 备份脚本 / python", () => {
    const d = mkdtempSync(join(tmpdir(), "Cloud115-root-"));
    try {
      writeFileSync(join(d, "scripts"), "");
      writeFileSync(join(d, "_preview"), "");
      const old = process.env.P115_MCP_SERVER_HOME;
      process.env.P115_MCP_SERVER_HOME = d;
      try {
        const p = detectServerPaths();
        expect(p.root).toBe(d.replace(/\\+$/, ""));
        expect(p.lockDir).toContain("state");
        expect(p.stateDir).toContain("_preview");
        expect(p.backupScript).toContain("vault_backup_115.py");
        expect(p.python.toLowerCase()).toContain("python.exe");
      } finally {
        if (old === undefined) delete process.env.P115_MCP_SERVER_HOME;
        else process.env.P115_MCP_SERVER_HOME = old;
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("找不到服务器时返回空串而不是抛错", () => {
    const old = process.env.P115_MCP_SERVER_HOME;
    process.env.P115_MCP_SERVER_HOME = join(tmpdir(), "definitely-not-here-115");
    try {
      const p = detectServerPaths();
      // 机器上可能真的有 E:/D:/C: 盘上的 115-MCP-Server；只在没有时才断言为空
      if (!p.root) {
        expect(p.lockDir).toBe("");
        expect(p.backupScript).toBe("");
      } else {
        expect(p.root.length).toBeGreaterThan(0);
      }
    } finally {
      if (old === undefined) delete process.env.P115_MCP_SERVER_HOME;
      else process.env.P115_MCP_SERVER_HOME = old;
    }
  });

  it("pathExists 对空串与不存在路径都返回 false", () => {
    expect(pathExists("")).toBe(false);
    expect(pathExists(join(tmpdir(), "no-such-115-path-xyz"))).toBe(false);
  });

  it("别处的 115-MCP-Server 路径被判为「异乡路径」", () => {
    expect(isForeignServerPath("D:\\115-MCP-Server\\state", "E:\\115-MCP-Server")).toBe(true);
    expect(isForeignServerPath("E:\\115-MCP-Server\\state", "E:\\115-MCP-Server")).toBe(false);
    expect(isForeignServerPath("E:\\115-MCP-Server\\state\\", "E:\\115-MCP-Server")).toBe(false);
    // 与 115-MCP-Server 无关的路径不算异乡
    expect(isForeignServerPath("D:\\Books", "E:\\115-MCP-Server")).toBe(false);
    expect(isForeignServerPath("", "E:\\115-MCP-Server")).toBe(false);
  });
});
