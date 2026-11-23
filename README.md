# 115 Cloud

115 Cloud browses and manages your 115 cloud drive from inside Obsidian, and exposes a set of **policy-guarded** 115 tools to your agent (Copilot / OpenCode / Claude, …) over a token-protected local MCP endpoint.

> Plugin ID: `cloud-netdisk` · Desktop only (needs Node.js and a local 115 MCP helper for the backup feature).

**English** | [中文说明](#中文说明)

---

## Features

- **Sidebar file tree** — browse 115 folders level by level, with breadcrumbs, name search and a quota bar.
- **Local MCP server** — the plugin listens on `127.0.0.1` and exposes 115 read/write capabilities as structured tools that an agent can call. Every request must carry the `x-115-token` header.
- **Hard-coded safety policy** — this is enforced in code, not asked for in a prompt:
  - one file or folder per request; array/batch input is rejected;
  - deletions first move the item into a `_去重待删_YYYYMMDD/` quarantine folder, and are only cleared after a human confirms;
  - write operations are rate limited, and the plugin stops for confirmation after 3 consecutive writes;
  - no "empty trash" tool is provided;
  - the plugin shares a **cross-process global lock** with the Python batch scripts: while a batch job runs, the plugin refuses even read-only 115 requests;
  - every operation is appended to an audit log.
- **Read-only first** — write tools are disabled by default; enable them in the settings once read-only browsing works.
- **QR login** — the settings tab renders a QR code, so you can sign in by scanning it with the 115 mobile app.

---

## Installation

### From the community plugin directory (once approved)

Settings → Community plugins → Browse → search for `115 Cloud`.

### Manual

1. Download `main.js`, `manifest.json` and `styles.css` from this repository's Releases;
2. copy them into `<vault>/.obsidian/plugins/cloud-netdisk/`;
3. restart Obsidian and enable the plugin under Settings → Community plugins.

---

## Usage

### 1. Sign in to 115

Settings → 115 Cloud → "扫码登录" (QR login), then scan the code with the 115 mobile app. The cookie is stored in the plugin's `data.json`.

### 2. Open the sidebar

Click the cloud icon in the left ribbon, or run "打开 115 网盘侧栏" from the command palette.

### 3. Connect an agent (MCP)

The settings tab has a "复制 MCP 配置" (copy MCP config) button that copies:

```json
{
  "mcpServers": {
    "cloud-netdisk": {
      "url": "http://127.0.0.1:7300/mcp",
      "headers": { "x-115-token": "<token from the plugin settings>" }
    }
  }
}
```

Paste it into your agent's MCP configuration. The token is persisted, so it survives an Obsidian restart.

There is also a "复制 agent 使用指引" (copy agent guide) button containing the tool list, the red lines and the recommended workflow, ready to paste into a conversation.

### 4. Enable write tools (optional)

Tick "允许写工具" (allow write tools). Even then, every operation is subject to the policy above: rate limiting, quarantine for deletions, a stop after 3 consecutive writes, and the cross-process lock.

---

## MCP tools

**Read-only** (always available)

| Tool | Description |
|---|---|
| `list_dir({cid})` | List a folder; the root folder has cid `0` |
| `stat({cid_or_fid})` | Metadata for one file or folder (size, sha1, mtime) |
| `search({query, page})` | Search by name |
| `quota()` | Storage usage (total / used / free) |
| `health()` | 115 session health check |

**Write** (must be enabled in the settings)

| Tool | Description |
|---|---|
| `mkdir({pid, name})` | Create a folder |
| `rename({fid, new_name})` | Rename (the extension must be kept) |
| `move({fid, to_pid})` | Move an item |
| `quarantine({fid, name, size})` | Preferred way to delete: move into the quarantine folder |
| `delete_small_garbage({fid, name, size})` | Only small whitelisted junk files |
| `confirm_writes()` | Human confirmation after 3 consecutive writes |
| `preflight()` | Always called first (session / rate-limit state / quota / checklist freshness) |

---

## Security and privacy

- The plugin only listens on `127.0.0.1`, and every request needs the `x-115-token` header.
- The 115 cookie is stored in the local `data.json` only; it is never sent anywhere except to 115 itself.
- Audit logs of all 115 requests are written to the `data/` subfolder of the plugin folder.
- **Why this plugin needs filesystem and process access** (see the review notes "Direct Filesystem Access" and "Shell Execution"):
  - the optional one-click vault backup unpacks/verifies archives and hands the job to the local `115-MCP-Server` Python helper (`scripts/vault_backup_115.py`), which does the 7-Zip compression and the chunked upload to 115;
  - the cross-process lock file must live in a directory shared with that Python side, which is why it can be outside the vault; its path is configured by the user and defaults to the detected `115-MCP-Server` state directory;
  - the audit log and the plugin's own data live in the plugin folder inside the vault;
  - the plugin never runs a command received from the 115 API, from an agent, or from a note. The command it spawns is a fixed Python interpreter plus a script path that the user configures in the settings; if that path does not exist, the backup aborts with an error.
  - The backup feature is opt-in: it only runs when you press the button, and "include plugin credentials in the archive" is off by default.

---

## Development

```bash
npm install
npm run dev        # watch build
npm run build      # type check + production build (output: dist/main.js)
npm run typecheck  # type check only
npm run lint       # eslint, including the official obsidianmd rules
npm test           # vitest
```

Deploy to a local vault on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
```

### Releasing

1. Bump `version` in `manifest.json` and add the matching entry to `versions.json`;
2. commit and create a tag **identical to the version number** (for example `0.2.3`, no `v` prefix);
3. push the tag — GitHub Actions builds and attaches `main.js`, `manifest.json` and `styles.css` to the Release;
4. submit the repository from the developer dashboard at [community.obsidian.md](https://community.obsidian.md/).

---

## License

MIT, see [LICENSE](LICENSE).

---

## 中文说明

在 Obsidian 里浏览和管理你的 115 网盘，并把一组**带安全策略**的 115 工具通过本地 MCP 端点暴露给你的 Agent（Copilot / OpenCode / Claude 等）。

> 插件 ID：`cloud-netdisk` | 仅桌面端（需要 Node.js / 本地 HTTP 监听）

### 功能

- **侧边栏文件树**：浏览 115 目录、逐层进入、面包屑导航、名称搜索、容量条。
- **本地 MCP 服务**：插件在 `127.0.0.1` 上开一个带令牌校验的 MCP 端点，把 115 的读/写能力暴露成结构化工具给 Agent 调用。
- **硬编码安全策略**（不是"提示词里请自律"，而是代码里强制执行）：
  - 一次只处理 1 个文件或目录，不接受数组批量；
  - 删除类请求一律先移到 `_去重待删_YYYYMMDD/` 隔离目录，人工确认后再清空；
  - 写操作强制限速，连续 3 次写后必须停下等确认；
  - 不提供"清空回收站"的工具；
  - 与 Python 批处理脚本**共用一把跨进程全局锁**，批处理在跑时插件连只读请求都拒绝；
  - 全部操作落审计日志。
- **只读优先**：写工具默认关闭，先用只读跑通再在设置里放开。
- **扫码登录**：设置页可直接出二维码扫码获取 115 Cookie。

### 安装

- 社区插件市场（审核通过后）：设置 → 第三方插件 → 浏览 → 搜索 `115 Cloud`。
- 手动：从 Releases 下载 `main.js`、`manifest.json`、`styles.css`，放入 `<库>/.obsidian/plugins/cloud-netdisk/`，重启 Obsidian 后在第三方插件里启用。

### 使用

1. **登录 115**：设置 → 115 Cloud → 「扫码登录」，用 115 App 扫二维码。Cookie 保存在插件目录的 `data.json` 中。
2. **打开侧栏**：左侧边栏的云朵图标，或命令面板搜「打开 115 网盘侧栏」。
3. **接入 Agent（MCP）**：设置页「复制 MCP 配置」会复制一段 JSON（`url` 为 `http://127.0.0.1:7300/mcp`，`headers` 带 `x-115-token`），粘到 Agent 客户端的 MCP 配置里即可。令牌持久化保存，重启 Obsidian 不变。同页的「复制 agent 使用指引」包含工具清单、红线和推荐流程。
4. **放开写工具（可选）**：设置页勾选「允许写工具」。放开后仍受全部策略约束：限速、隔离删除、连续 3 次停下确认、跨进程锁。

### MCP 工具一览

**只读**（随时可用）：`list_dir({cid})`、`stat({cid_or_fid})`、`search({query, page})`、`quota()`、`health()`。

**写**（需在设置里放开）：`mkdir({pid, name})`、`rename({fid, new_name})`、`move({fid, to_pid})`、`quarantine({fid, name, size})`、`delete_small_garbage({fid, name, size})`、`confirm_writes()`、`preflight()`。

### 安全与隐私

- 插件只在 `127.0.0.1` 上监听，访问需要 `x-115-token` 头。
- 115 Cookie 只存在本地 `data.json`，不会上传到任何第三方。
- 所有 115 请求的审计日志写在插件目录的 `data/` 子目录。
- 插件会读写自己的插件目录，并按需在 115 端创建隔离目录。

### 开发与发布

```bash
npm install
npm run build      # 类型检查 + 生产构建（产物在 dist/main.js）
npm run typecheck
npm test
```

部署到本地库（Windows）：`powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1`。

发布：改 `manifest.json` 的 `version` 并同步 `versions.json` → 打与版本号完全一致的 tag（不带 `v`）→ 推 tag，GitHub Actions 自动构建并挂 Release → 到 [community.obsidian.md](https://community.obsidian.md/) 提交仓库。
