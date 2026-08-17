# dsh-time-stamp

> DeepSeek Harness 动态插件：在每个用户提问进入模型之前，向会话日志注入一条**持久化的时钟上下文消息**（提问接收时间 + 距上一条提问的间隔），让 Agent 具备精确的时间观念。**缓存友好、意图无歧义、界面隐身呈现**，并支持**按项目（工作区）独立启用/停用**。

[中文](#中文) · [English](#english)

---

## 中文

### 功能特性

- **自动时间戳**：每条用户消息（提问、追问/steer）在进入模型步骤前自动附带时钟读数；工具循环的中间步骤不重复注入
- **相对时间校准**：注入消息包含「距上一条提问的间隔」，并明确指示模型将「现在 / 今天 / 刚才」等相对表述锚定到该时刻
- **按项目开关**：会话头部右侧「时间戳 开/关」按钮，每个工作区独立记忆；「设置 → 通用」提供全局默认开关
- **缓存友好**：注入消息一次性写入会话日志，之后每次请求逐字节重放同一内容，不扩大模型前缀缓存的未命中区
- **无歧义**：注入的是独立消息，不改动用户原文一个字，并明确标注为系统时钟元数据
- **界面隐身**：不显示为消息气泡，而是呈现为一行可折叠的灰色小字「上下文注入」行（产品为注入上下文设计的原生呈现）
- **配置持久化**：`~/.dsh/storages/time_stamp.json`

### 注入内容示例

> Time the user's latest message was received: 2026-08-17T15:33:51+08:00[Asia/Shanghai]. Elapsed since the previous user message: 4m 40s. Interpret relative time references (now, today, yesterday, 现在, 今天, 刚才) against this instant.

### 安装（动态插件方式）

本插件以 DSH 动态插件形式运行，源码可直接提交给 `cordis_define`：

1. 在 DSH 会话中调用 `cordis_define`（`kind: "new"`，`idPrefix: "tstmp"`）：
   - `code.host` ← [plugin/host.js](plugin/host.js) 全文
   - `code.client` ← [plugin/client.js](plugin/client.js) 全文
2. 调用 `cordis_run` 激活，并在界面批准授权（建议双 ✓ 授权未来版本）
3. 会话右上角出现「时间戳 开」按钮即安装成功

> 注意：动态插件是进程内的，DSH 重启后需要重新加载。保留本仓库即可随时重建，配置（每项目开关）持久化在存储文件中，重建后依然生效。

### 使用

| 操作 | 位置 | 作用范围 |
|---|---|---|
| 「时间戳 开/关」按钮 | 任意会话头部右侧 | 当前工作区（同项目所有会话共享） |
| 「时间戳注入」开关 | 设置 → 通用 | 全局默认值 |
| `time_stamp.json` | `~/.dsh/storages/` | 配置落盘位置 |

关闭某项目后，**新消息不再注入**；历史已注入的消息保留在日志中（删除会破坏缓存连续性，属设计行为）。

### 常见问题

- **开关点击无反应**：检查 `~/.dsh/storages/time_stamp.json` 是否生成；按钮变红并悬停可查看具体原因。已知坑：存储域名必须匹配 `/^[a-z][a-z0-9_]*$/`（**不允许连字符**），曾因域名 `time-stamp` 含 `-` 导致写入路径静默失败（详见 [docs/design.md](docs/design.md)）
- **时间戳没出现**：确认该项目开关为「开」，且消息确实是用户来源（系统消息/工具消息不触发）
- **为什么不是完全隐身**：DSH 的产品不变量是「模型可见内容必须来自会话日志」（`agent/request` 文档原文），不存在只给模型看、不进日志的通道；本插件采用官方 `time-context` 同款持久化方案，界面呈现为产品原生设计的折叠式「上下文注入」小字行

### 工作原理

详见 [docs/design.md](docs/design.md)：注入点选型（`agent/pre-step` vs `llm/stream` vs `system-prompt`）、缓存命中率分析、存储方案选型（为何绕开 `settings.register`）、故障排查记录。

### 许可证

[MIT](LICENSE)

---

## English

> DeepSeek Harness dynamic plugin: injects a durable clock-context message after every user question so the agent has an accurate sense of time. Cache-friendly, intent-safe, stealth presentation, with per-workspace enable/disable.

### Highlights

- One clock reading per user-origin message, injected at `agent/pre-step`; tool-loop steps are never re-stamped
- The reading includes elapsed time since the previous user message and instructs the model to anchor relative time references to that instant
- Per-project toggle in the session header + a global default in Settings → General
- The injected message is written to the session log **once** and replayed byte-identically on every later request → provider prefix cache keeps hitting
- The user's own text is never modified; the clock reading is a separate, clearly labeled context message rendered as a collapsible "context injection" row
- Config persisted at `~/.dsh/storages/time_stamp.json`

### Install (dynamic plugin)

Submit [plugin/host.js](plugin/host.js) as `code.host` and [plugin/client.js](plugin/client.js) as `code.client` to DSH's `cordis_define` (`idPrefix: "tstmp"`), then `cordis_run` and approve. Dynamic plugins are process-local — reload after a DSH restart (config survives).

### License

[MIT](LICENSE)
