/**
 * 一键备份到 115：命令拼装 / 进度解析 / 路径解析的单测。
 *
 * 不真正 spawn 子进程（注入 fake spawner），只断言：
 *  - 参数里带上了正确的 vault / 子目录 / 保留数
 *  - 默认**不带** --include-secrets（凭据不进包）
 *  - JSONL 进度能逐行被解析（含被拆成多段的 chunk）
 *  - 退出码能正确回传
 */

import { describe, expect, it } from "vitest";
import { EventEmitter } from "events";
import { describeProgress, resolvePath, resolvePython, startVaultBackup } from "../src/backup/vaultBackup";

class FakeProc extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  killed = false;
  kill(): void {
    this.killed = true;
  }
  emitStdout(text: string): void {
    this.stdout.emit("data", text);
  }
  emitClose(code: number): void {
    this.emit("close", code);
  }
}

function fakeSpawner(proc: FakeProc) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawner = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return proc;
  }) as never;
  return { spawner, calls };
}

function baseOpts(overrides: Partial<Parameters<typeof startVaultBackup>[0]> = {}) {
  return {
    vaultPath: "D:\\Books",
    vaultName: "Books",
    scriptPath: "D:\\115-MCP-Server\\scripts\\vault_backup_115.py",
    pythonPath: "D:\\115-MCP-Server\\.venv\\Scripts\\python.exe",
    backupRoot: "[00]obsidian 备份  2026.11.20",
    subdirTemplate: "{vault} 参考资料",
    keep: 3,
    tmpDir: "D:\\_tmp",
    includeSecrets: false,
    ...overrides,
  };
}

describe("一键备份 · 命令拼装", () => {
  it("传对 vault / 子目录（{vault} 已替换）/ 保留数", () => {
    const proc = new FakeProc();
    const { spawner, calls } = fakeSpawner(proc);
    startVaultBackup(baseOpts({ spawner: spawner as never }), () => undefined);
    const { args } = calls[0];
    expect(args[0]).toBe("D:\\115-MCP-Server\\scripts\\vault_backup_115.py");
    expect(args).toContain("--vault");
    expect(args[args.indexOf("--vault") + 1]).toBe("D:\\Books");
    expect(args[args.indexOf("--subdir") + 1]).toBe("Books 参考资料");
    expect(args[args.indexOf("--keep") + 1]).toBe("3");
    expect(args[args.indexOf("--backup-root") + 1]).toBe("[00]obsidian 备份  2026.11.20");
  });

  it("默认不带 --include-secrets（凭据不进包）", () => {
    const proc = new FakeProc();
    const { spawner, calls } = fakeSpawner(proc);
    startVaultBackup(baseOpts({ spawner: spawner as never }), () => undefined);
    expect(calls[0].args).not.toContain("--include-secrets");
  });

  it("显式打开时才带 --include-secrets", () => {
    const proc = new FakeProc();
    const { spawner, calls } = fakeSpawner(proc);
    startVaultBackup(baseOpts({ spawner: spawner as never, includeSecrets: true }), () => undefined);
    expect(calls[0].args).toContain("--include-secrets");
  });

  it("dryRun 会带 --dry-run", () => {
    const proc = new FakeProc();
    const { spawner, calls } = fakeSpawner(proc);
    startVaultBackup(baseOpts({ spawner: spawner as never, dryRun: true }), () => undefined);
    expect(calls[0].args).toContain("--dry-run");
  });
});

describe("一键备份 · 进度解析", () => {
  it("能解析被拆成多段的 JSONL（跨 chunk 边界）", async () => {
    const proc = new FakeProc();
    const { spawner } = fakeSpawner(proc);
    const seen: string[] = [];
    const handle = startVaultBackup(baseOpts({ spawner: spawner as never }), (p) => seen.push(p.stage));

    proc.emitStdout('{"stage":"pack","ts":0}\n{"stage":"pac');
    proc.emitStdout('ked","ts":1,"size":100}\n');
    proc.emitStdout('{"stage":"upload","ts":2}\n');
    proc.emitClose(0);
    const code = await handle.done;

    expect(code).toBe(0);
    expect(seen).toEqual(["pack", "packed", "upload"]);
  });

  it("非 JSON 行被忽略，不影响后续解析", async () => {
    const proc = new FakeProc();
    const { spawner } = fakeSpawner(proc);
    const seen: string[] = [];
    const handle = startVaultBackup(baseOpts({ spawner: spawner as never }), (p) => seen.push(p.stage));

    proc.emitStdout("7-Zip 4.19 Copyright\n");
    proc.emitStdout('{"stage":"packed","ts":0}\n');
    proc.emitClose(0);
    await handle.done;
    expect(seen).toEqual(["packed"]);
  });

  it("退出码透传（失败时非 0）", async () => {
    const proc = new FakeProc();
    const { spawner } = fakeSpawner(proc);
    const handle = startVaultBackup(baseOpts({ spawner: spawner as never }), () => undefined);
    proc.emitClose(3);
    expect(await handle.done).toBe(3);
  });

  it("cancel() 会 kill 子进程", () => {
    const proc = new FakeProc();
    const { spawner } = fakeSpawner(proc);
    const handle = startVaultBackup(baseOpts({ spawner: spawner as never }), () => undefined);
    handle.cancel();
    expect(proc.killed).toBe(true);
  });
});

describe("一键备份 · 辅助函数", () => {
  it("describeProgress 覆盖关键阶段并对未知阶段回退", () => {
    expect(describeProgress({ stage: "upload", ts: 0 })).toContain("上传");
    expect(describeProgress({ stage: "verified", ts: 0 })).toContain("校验");
    expect(describeProgress({ stage: "error", ts: 0, message: "boom" })).toContain("boom");
    expect(describeProgress({ stage: "weird", ts: 0, message: "自定义" })).toBe("自定义");
  });

  it("resolvePath 保留绝对路径、相对路径拼到 vault 下", () => {
    expect(resolvePath("D:\\Books", "D:\\x")).toBe("D:\\x");
    expect(resolvePath("D:\\Books", "sub")).toContain("Books");
  });

  it("resolvePython 在配置为空时能回退到存在的 .venv", () => {
    const p = resolvePython("D:\\115-MCP-Server\\scripts\\vault_backup_115.py", "");
    expect(p.toLowerCase()).toContain("python");
  });
});
