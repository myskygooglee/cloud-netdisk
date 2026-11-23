# 115 Cloud

在 Obsidian 里浏览和管理你的 115 网盘，并把一组**带安全策略**的 115 工具通过本地 MCP 端点暴露给你的 Agent（Copilot / OpenCode / Claude 等）。

> 插件 ID：`cloud-netdisk` | 版本：0.2.0 | 仅桌面端（需要 Node.js / 本地 HTTP 监听）

---

## 功能

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

---

## 安装

### 从社区插件市场安装（审核通过后）

设置 → 第三方插件 → 浏览 → 搜索 `115 Cloud`。

### 手动安装

1. 从本仓库的 Releases 下载 `main.js`、`manifest.json`、`styles.css`；
2. 放入 `<库>/.obsidian/plugins/cloud-netdisk/`；
3. 重启 Obsidian，在设置 → 第三方插件中启用。

---

## 使用

### 1. 登录 115

设置 → 115 Cloud → 「扫码登录」，用 115 App 扫二维码。Cookie 会保存在插件目录的 `data.json` 中。

### 2. 打开侧边栏

左侧边栏的云朵图标，或命令面板搜「打开 115 网盘侧栏」。

### 3. 接入 Agent（MCP）

设置页有「复制 MCP 配置」按钮，会复制一段 JSON：

```json
{
  "mcpServers": {
    "cloud-netdisk": {
      "url": "http://127.0.0.1:7300/mcp",
      "headers": { "x-115-token": "<插件设置里的令牌>" }
    }
  }
}
```

把它粘到你的 Agent 客户端的 MCP 配置里即可。令牌持久化保存，重启 Obsidian 不变。

同一页面还有「复制 agent 使用指引」，包含给 Agent 的工具清单、红线和推荐流程，可以直接贴进对话里让 Agent 读。

### 4. 放开写工具（可选）

设置页勾选「允许写工具」。放开后仍受上述全部策略约束：限速、隔离删除、连续 3 次停下确认、跨进程锁。

---

## MCP 工具一览

**只读**（随时可用）

| 工具 | 说明 |
|---|---|
| `list_dir({cid})` | 列出目录内容，根目录 cid = `0` |
| `stat({cid_or_fid})` | 单个文件/目录的元数据（大小、sha1、mtime） |
| `search({query, page})` | 按名称搜索 |
| `quota()` | 容量（总 / 已用 / 剩余） |
| `health()` | 115 会话健康度检查 |

**写**（需在设置里放开）

| 工具 | 说明 |
|---|---|
| `mkdir({pid, name})` | 建目录 |
| `rename({fid, new_name})` | 重命名（**必须带扩展名**） |
| `move({fid, to_pid})` | 移动 |
| `quarantine({fid, name, size})` | 删除类操作首选：移入隔离目录 |
| `delete_small_garbage({fid, name, size})` | 仅白名单小垃圾文件 |
| `confirm_writes()` | 连续 3 次写操作后的人工确认 |
| `preflight()` | 开工前必查（会话 / 风控 / 容量 / 清单时效） |

---

## 安全与隐私

- 插件只在 `127.0.0.1` 上监听，访问需要 `x-115-token` 头。
- 115 Cookie 只存在本地 `data.json`，不会上传到任何第三方。
- 所有 115 请求的审计日志写在插件目录的 `data/` 子目录。
- 插件会读写自己的插件目录，并按需在 115 端创建隔离目录。

---

## 开发

```bash
npm install
npm run dev        # 监听构建
npm run build      # 类型检查 + 生产构建（产物在 dist/main.js）
npm run typecheck  # 仅类型检查
npm test           # Vitest
```

部署到本地库（Windows）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/deploy.ps1
```

### 发布

1. 改 `manifest.json` 的 `version`，同步更新 `versions.json`；
2. 提交并打 **与版本号完全一致** 的 tag（如 `0.2.0`，不带 `v` 前缀）；
3. 推送 tag，GitHub Actions 会自动构建并把 `main.js`、`manifest.json`、`styles.css` 挂到 Release 上；
4. 登录 [community.obsidian.md](https://community.obsidian.md/) 的开发者面板，连接 GitHub 后提交仓库，等待自动审核（通常几分钟），通过后 24 小时内可在 App 内搜到。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
