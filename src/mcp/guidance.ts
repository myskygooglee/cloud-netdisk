/**
 * agent 与用户的引导文案。
 *
 * 只做"说明"，不改任何执行行为：
 *  - 工具描述里补上安全提示（让 agent 自己就知道红线）
 *  - 设置页展示「使用指引」，并可一键复制给 Copilot
 */

export const READ_ONLY_BANNER = [
  "**当前处于只读模式**：agent 只能调用 `list_dir / stat / search / quota / health` 五个只读工具。",
  "",
  "写工具（`mkdir / rename / move / quarantine / delete_small_garbage`）默认**关闭**，需要你在设置里手动打开。",
].join("\n");

export const WRITE_MODE_BANNER = [
  "**写工具已放开**，但仍受以下硬约束（与 `AGENTS.md` 一致，不可绕过）：",
  "",
  "| 约束 | 行为 |",
  "|---|---|",
  "| 单次单文件 | 所有写工具一次只处理 1 个文件/目录，不接受数组 |",
  "| 串行不并发 | 所有 115 请求排队执行 |",
  "| 限速 | 读 ≥1s/次，写 ≥3s/次，每 2 次写额外冷却 60s |",
  "| 3 写停 | 连续 3 次写操作后停下，需 `confirm_writes` 确认才继续 |",
  "| 风控熔断 | 命中 `429 / 405 / 990001 / 风控 / 频繁` 立即停止全部 115 操作 |",
  "| 跨进程互斥 | Python 批处理持锁期间，插件连只读请求也拒绝（`115.lock.json`，心跳 90s） |",
  "| 视频/归档先隔离 | 删除类请求会被路由到 `quarantine`（移动到 `_去重待删_YYYYMMDD/`） |",
  "| 回收站 | 不提供清空回收站的工具 |",
].join("\n");

/** 给 agent 的用法说明（复制到 Copilot 对话里即可）。 */
export const AGENT_GUIDE = [
  "# 115 agent 使用指引（cloud-115）",
  "",
  "你可以通过以下本地 MCP 工具操作用户的 115 网盘：",
  "",
  "## 只读工具（随时可用）",
  "- `list_dir({cid})` 列出目录内容，根目录 cid = `0`",
  "- `stat({cid_or_fid})` 查看单个文件/目录的元数据（大小、sha1、mtime）",
  "- `search({query, page})` 按名称搜索",
  "- `quota()` 读取容量（总/已用/剩余）",
  "- `health()` 检查 115 会话健康度（会话半失效时用）",
  "",
  "## 写工具（需用户在设置里放开）",
  "- `mkdir({pid, name})` 建一个目录",
  "- `rename({fid, new_name})` 重命名（**必须带扩展名**）",
  "- `move({fid, to_pid})` 移动到目标目录",
  "- `quarantine({fid, name, size})` **删除类操作的首选**：把视频/归档移入隔离目录 `_去重待删_YYYYMMDD/`",
  "- `delete_small_garbage({fid, name, size})` 仅限白名单小垃圾文件（jpg/png/url/txt/html/gif/torrent/mht 等）",
  "- `confirm_writes()` 连续 3 次写操作后的人工确认",
  "- `preflight()` 开工前必查（会话/风控/容量/清单时效）",
  "",
  "## 红线（工具会强制执行，不要尝试绕过）",
  "1. **一次只处理一个文件或目录**，不要传数组。",
  "2. **删除一律先隔离**：视频/压缩包用 `quarantine`；其它类型 `delete_small_garbage` 会被拒绝。",
  "3. **不要清空回收站**：没有这个工具，也不要反复删同一批文件。",
  "4. **连续 3 次写操作会被停下**，此时应调用 `confirm_writes` 或把情况汇报给用户。",
  "5. **会话报错时停止**：若返回 `session_expired` 或 `990001`，不要再重试，请提示用户重新扫码登录。",
  "6. **批处理在跑时全停**：若返回 `⛔ 115 批处理正在运行`，说明 Python 批处理持有全局锁；此时不要重试、不要换工具，直接告诉用户等批处理结束（锁心跳 90s 未刷新会自动失效）。",
  "",
  "## 建议流程",
  "1. `health()` 确认会话正常 → 2. `preflight()` → 3. `list_dir`/`search` 定位目标 → 4. 需要删除就 `quarantine` → 5. 向用户汇报做了什么。",
].join("\n");

/** 追加到只读工具描述末尾的提示。 */
export const READ_ONLY_HINT = "（只读操作，随时可用）";

/** 追加到写工具描述末尾的提示。 */
export const WRITE_HINT = "（写操作：需用户在插件设置中放开写工具；一次只处理 1 个文件/目录；删除类请优先用 quarantine）";
