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
- **配置持久化**：常驻版写入 `~/.dsh/settings.yaml` 的 `time-stamp` 段（动态版为 `~/.dsh/storages/time_stamp.json`）

### 注入内容示例

> 【系统时钟】最新一条用户消息的接收时间：2026-08-17T15:33:51+08:00[Asia/Shanghai]。距上一条用户消息：4 分 40 秒。请以该时刻为基准理解相对时间表述（如「现在、今天、昨天、刚才」）。

### 安装（静态常驻版，推荐）

动态插件是进程内的，DSH 重启后需要重新加载。**常驻版**是普通 npm 插件包（`static/` 目录），随组合加载，重启不丢、无需批准：

1. 安装包体：把 `static/` 复制为 `~/.dsh/profiles/web/node_modules/dsh-time-stamp/`（package.json 位于该目录根部）
2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `- insert:` 列表追加一行：

   ```yaml
   - id: dsh-time-stamp
     name: 'dsh-time-stamp'
   ```

3. 重启 DSH（组合变更需重启生效），右上角出现「时间戳 开」即成功

> **配置迁移**：常驻版把配置写入 `settings.yaml` 的 `time-stamp` 段（全局默认 + 每工作区覆盖，schema 校验），不再使用 `~/.dsh/storages/time_stamp.json`（旧的 storage 文件可删）。行为与动态版一致：缓存友好、不改用户原文、界面为折叠的「上下文注入」行、按项目开关。

### 安装（动态插件方式）

本插件最初以 DSH 动态插件形式运行，源码同样保留在仓库中，可直接提交给 `cordis_define`：

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
| `settings.yaml` → `time-stamp` 段 | `~/.dsh/` | 配置落盘位置（常驻版） |

关闭某项目后，**新消息不再注入**；历史已注入的消息保留在日志中（删除会破坏缓存连续性，属设计行为）。

### 常见问题

- **开关点击无反应**：看按钮是否变红并在悬停提示里给出原因（客户端不会静默失败）；配置是否写入 `~/.dsh/settings.yaml` 的 `time-stamp` 段。历史坑记录：动态版曾因存储域名含连字符（`UNIT_NAME_RE` 不允许 `-`）导致写入静默失败；静态版另有一个真实坑——第三方命名空间不在 apiProxy 白名单内，故客户端通道已改为自建 webServer 路由（详见 [docs/design.md](docs/design.md)）
- **时间戳没出现**：确认该项目开关为「开」，且消息确实是用户来源（系统消息/工具消息不触发）
- **为什么不是完全隐身**：DSH 的产品不变量是「模型可见内容必须来自会话日志」（`agent/request` 文档原文），不存在只给模型看、不进日志的通道；本插件采用官方 `time-context` 同款持久化方案，界面呈现为产品原生设计的折叠式「上下文注入」小字行

### 工作原理

详见 [docs/design.md](docs/design.md)：注入点选型（`agent/pre-step` vs `llm/stream` vs `system-prompt`）、缓存命中率分析、存储方案选型（动态版绕开 `settings.register` 的原因与静态版的正规化）、静态化移植记录、故障排查。

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
- The injected reading is **Chinese prose** (`【系统时钟】最新一条用户消息的接收时间：…`), with the instant kept in ISO form for unambiguity; durations use Chinese units (`1 天 1 小时 1 分 1 秒`)
- Config persisted in the `time-stamp` section of `~/.dsh/settings.yaml` (the static form; the legacy dynamic form used `~/.dsh/storages/time_stamp.json`)

### Install (dynamic plugin)

Submit [plugin/host.js](plugin/host.js) as `code.host` and [plugin/client.js](plugin/client.js) as `code.client` to DSH's `cordis_define` (`idPrefix: "tstmp"`), then `cordis_run` and approve. Dynamic plugins are process-local — reload after a DSH restart (config survives).

### License

[MIT](LICENSE)
