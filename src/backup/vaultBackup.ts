/**
 * Vault 一键备份到 115：调用 `vault_backup_115.py`，逐行读 JSONL 进度。
 *
 * 为什么走 Python 而不是自己实现打包+上传：
 *  - 打包要 7-Zip（带排除清单、多线程），Electron 里手写 zip 又慢又容易漏排除；
 *  - 上传要走 115 的 init → 二次校验 → OSS 分块 → 回调，p115client 已经稳定实现，
 *    重写一遍纯属给自己埋雷（尤其是 >10MB 必须分块这条）。
 *  - 脚本自带跨进程 115 锁，备份期间 `quarantine_115.py` 不会同时打 115。
 *
 * 插件这边只负责：起进程、读进度、把结果回显给人。
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { existsSync } from "fs";
import { dirname, isAbsolute, join } from "path";

export interface BackupProgress {
  stage: string;
  ts: number;
  message?: string;
  percent?: number;
  size?: number;
  sha1?: string;
  cid?: number;
  name?: string;
  ok?: boolean;
  code?: number;
  skipped?: boolean;
}

export interface BackupOptions {
  /** vault 的绝对路径 */
  vaultPath: string;
  /** vault 名（决定 zip 名与默认子目录） */
  vaultName: string;
  /** 备份脚本绝对路径 */
  scriptPath: string;
  /** python 解释器；空则用脚本目录下的 .venv */
  pythonPath: string;
  /** 115 上的备份根目录名 */
  backupRoot: string;
  /** 子目录模板，`{vault}` 会被替换 */
  subdirTemplate: string;
  /** 保留几个 zip（0 = 不限） */
  keep: number;
  /** 本地临时目录（空 = 用脚本默认的 115-MCP-Server\_tmp） */
  tmpDir: string;
  /** 是否把 data.json（含凭据）也打进包 */
  includeSecrets: boolean;
  /** 只打包不上传 */
  dryRun?: boolean;
  /** 测试注入：不真正 spawn */
  spawner?: typeof spawn;
}

export interface BackupHandle {
  /** 等到脚本结束，返回退出码 */
  done: Promise<number>;
  /** 主动终止 */
  cancel: () => void;
  /** 原始进程（可能为 null，测试时） */
  proc: ChildProcessWithoutNullStreams | null;
}

const DEFAULT_VENV_PY = "D:\\115-MCP-Server\\.venv\\Scripts\\python.exe";

/** 推断 python 解释器：显式配置 → 脚本同级 .venv → 服务器目录 .venv → 系统 python */
export function resolvePython(scriptPath: string, configured: string): string {
  const cands = [
    configured,
    join(dirname(scriptPath), "..", ".venv", "Scripts", "python.exe"),
    DEFAULT_VENV_PY,
  ].filter(Boolean);
  for (const c of cands) {
    if (existsSync(c)) return c;
  }
  return configured || "python";
}

/** 把界面上填的相对/绝对路径统一成绝对路径（相对路径按 vault 根解析）。 */
export function resolvePath(vaultPath: string, p: string): string {
  if (!p) return p;
  return isAbsolute(p) ? p : join(vaultPath, p);
}

/**
 * 启动备份进程。
 *
 * 注意 `--include-secrets` 默认关闭：`.obsidian/plugins/<每个插件>/data.json` 里有 115 Cookie
 * 与各种 API key，与 `VAULT-BACKUP-SPEC.md` 第 10 节红线一致。
 */
export function startVaultBackup(opts: BackupOptions, onProgress: (p: BackupProgress) => void): BackupHandle {
  const args = [
    opts.scriptPath,
    "--vault", opts.vaultPath,
    "--vault-name", opts.vaultName,
    "--backup-root", opts.backupRoot,
    "--subdir", opts.subdirTemplate.replace("{vault}", opts.vaultName),
    "--keep", String(opts.keep),
    "--wait-plugin", "0",
  ];
  if (opts.tmpDir) args.push("--tmp-dir", opts.tmpDir);
  if (opts.includeSecrets) args.push("--include-secrets");
  if (opts.dryRun) args.push("--dry-run");

  const python = resolvePython(opts.scriptPath, opts.pythonPath);
  const spawner = opts.spawner ?? spawn;
  const proc = spawner(python, args, {
    cwd: dirname(opts.scriptPath),
    windowsHide: true,
  });

  let buffer = "";
  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        onProgress(JSON.parse(line) as BackupProgress);
      } catch {
        // 非 JSON 行（7z 偶尔会往 stdout 混东西）直接忽略
      }
    }
  });

  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (chunk: string) => {
    // 脚本的人话日志；只在 debug 里留一份，避免刷屏
    console.debug("[vault-backup]", String(chunk).trimEnd());
  });

  const done = new Promise<number>((resolve) => {
    proc.on("error", (err) => {
      onProgress({ stage: "error", ts: 0, message: `无法启动备份进程：${err.message}`, code: -1 });
      resolve(-1);
    });
    proc.on("close", (code) => resolve(code ?? -1));
  });

  return {
    done,
    proc,
    cancel: () => {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  };
}

/** 人类可读的进度文案（给 Notice / 侧栏用）。 */
export function describeProgress(p: BackupProgress): string {
  switch (p.stage) {
    case "start":
      return p.message ?? "开始备份…";
    case "pack":
      return "正在打包（7-Zip，mx=1）…";
    case "packed":
      return p.message ?? "打包完成";
    case "hash":
    case "hashing":
      return `计算 sha1${p.percent !== undefined ? ` ${p.percent}%` : ""}…`;
    case "hashed":
      return "sha1 计算完成";
    case "locked":
      return "已获取 115 全局锁";
    case "session":
      return "检查 115 会话…";
    case "session_ok":
      return p.message ?? "会话正常";
    case "target":
      return "定位 115 目标目录…";
    case "target_ok":
      return p.message ?? "目标目录就绪";
    case "rename_prev":
      return p.message ?? "处理同名旧包…";
    case "skip_same":
      return p.message ?? "远端已有同内容包，跳过上传";
    case "upload":
      return "正在上传到 115（分块流式）…";
    case "uploaded":
      return p.message ?? "上传完成";
    case "verify":
      return "校验远端 sha1…";
    case "verified":
      return "已校验 ✅";
    case "pruned":
    case "keep":
      return p.message ?? "整理旧包…";
    case "cleanup":
      return "已清理本地临时包";
    case "unlocked":
      return "已释放 115 全局锁";
    case "done":
      return p.message ?? "备份完成";
    case "error":
      return `❌ ${p.message ?? "备份失败"}`;
    default:
      return p.message ?? p.stage;
  }
}
