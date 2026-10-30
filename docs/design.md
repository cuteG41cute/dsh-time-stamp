# dsh-time-stamp 设计文档

本文档记录插件的关键设计决策、约束排查与故障记录，方便后续维护与二次开发。

## 1. 需求与约束

1. 每个用户提问发出时，自动在提问后添加时间戳，让模型理解上下文时间逻辑
2. 时间戳不能影响模型缓存命中率（或影响降至最低）
3. 时间戳不能影响模型对用户意图的理解（无歧义）
4. 时间戳不要粗暴显示在聊天界面（隐身优先）
5. 用户可以在每个项目（工作区）下选择是否启用

## 2. 注入点选型

DSH 的模型请求链路：

```
用户消息 → inbox → agent/pre-step（waterfall，可替换进入 step 的消息）
        → 消息追加进会话日志（user/message 事件，surfaceOp: append）
        → session.deriveMessages()（日志 → 模型消息，无钩子）
        → buildRequest()（deepFreeze 冻结请求）
        → llm/stream（waterfall，options 已冻结，只能读）
        → 适配器
```

| 候选注入点 | 结论 |
|---|---|
| `agent/pre-step` | ✅ 采用。可向决策消息追加内容；追加的消息由 agent-loop 写入日志（`session.append("user/message", ...)`），此后每次请求逐字节重放 |
| `agent/request` | ❌ 官方文档明确 "Model-visible content must use logged channels; this waterfall cannot mutate messages" |
| `llm/stream` | ❌ 请求对象在 `buildRequest` 中被 `deepFreeze`，waterfall 的 `next()` 闭包捕获原始 options，无法改写消息；且跳过 `next()` 会短路 invariant 校验 |
| `system-prompt/assemble` / `variable` | ❌ 系统提示词每步重新组装，动态时间会导致每一步都打碎缓存前缀（系统提示词是缓存头部） |

**结论**：唯一可行的注入点是 `agent/pre-step`，且注入内容必然进入日志（= 模型可见 = UI 可渲染）。这同时解释了约束 4 的边界：产品不变量决定了「只给模型看、不进日志」的完全隐身通道不存在，因此采用官方 `dsh-time-context` 同款持久化方案，界面呈现为产品原生设计的折叠式「上下文注入」行（灰色小字、可展开、非用户气泡）。

## 3. 缓存命中率分析

注入策略：**每条用户来源消息注入一次**（step 1 或含新用户消息的 step），工具循环的中间步骤不注入；注入文本在注入时刻一次性确定，之后永不重算。

- 前缀缓存：历史消息（含注入消息）在后续每次请求中逐字节相同 → 前缀命中区不变
- 未命中区：新用户消息本身就会造成该位置必然未命中；注入消息落在这个区域内，**没有扩大未命中区**
- 无抖动：不采用「每步刷新当前时间」的策略（官方插件的 `refreshIntervalMs=0` 行为），因此同一轮内的工具循环步骤重放完全一致的序列化 → 完整命中
- 重试/回放：日志不变 → 序列化不变 → 命中

对比：若在 `system-prompt` 注入动态时间，每步系统提示词变化，缓存前缀整体失效，是反面教材。

## 4. 消息与文本设计（无歧义）

- 注入为**独立消息**（`source.kind: "plugin"`），绝不修改用户消息的 content
- 文本以「【系统时钟】最新一条用户消息的接收时间：…」开头，明确声明为系统时钟读数（**全中文行文**，仅时刻保留 ISO 形式——它locale无关、无歧义，且保证同刻逐字节一致）
- 附解释指令：相对时间表述（现在/今天/昨天/刚才）以此时刻为锚
- 附带「距上一条用户消息的间隔」（扫描会话日志中最近一条 `source.kind === "user"` 的 `user/message` 事件的 time 计算），中文单位输出（如「1 天 1 小时 1 分 1 秒」）
- 格式确定性：`Intl.DateTimeFormat("en-US", {..., hourCycle: "h23", timeZoneName: "longOffset"})`，同一时刻永远格式化出同一字符串；`renderClockText()` 为导出的纯函数，便于离线验证

## 5. 配置存储选型

动态插件沙箱**没有 import 能力**，因此无法使用 `settings.register`（需要 schemastery 的 `z`）。备选方案：

| 方案 | 结论 |
|---|---|
| `settings` 服务 | ❌ 注册 namespace 需要 zod/schemastery schema |
| `storageDomain`（json backend） | ✅ 采用。`storageDomain.open()` 只要求 spec 的 `valueSchema` 提供 `parse`/`safeParse`，用鸭子类型 schema（`parse: v => v`）即可绕过 zod 依赖 |
| workspace 实体 meta | ❌ Workspace 实体只有 id/path/title/时间戳，无 meta 袋 |

存储结构（`~/.dsh/storages/time_stamp.json`）：

```json
{
  "unit": { "name": "time_stamp", "version": 1 },
  "tables": {
    "projects": {
      "<workspaceId>": { "enabled": false },
      "__default__": { "enabled": true }
    }
  }
}
```

## 6. 故障记录

### 6.1 开关点击无反应（v1 → v3 修复）

- **现象**：时间戳注入正常，但「时间戳 开/关」按钮点击无任何反应
- **根因**：存储域名 `time-stamp` 含连字符，而 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` 不允许连字符。JSON backend 在 `kv.open()` 直接抛 `malformed-medium`，apply 的 catch 吞掉异常 → `table === null` → 读路径走 `DEFAULT_ENABLED` 兜底（按钮显示正常、注入正常），写路径返回 `ok: false` 被客户端静默忽略
- **修复**：域名改为 `time_stamp`；客户端增加失败可见性（红点 + 错误提示 + console.error）；Host 记录 `openError` 并通过 RPC 暴露 `storage` 字段
- **教训**：任何依赖外部服务初始化的逻辑，失败时不能只写日志，还要让 UI 能感知；命名必须核对契约中的正则

### 6.2 注入文本重复示例词

- 早期版本注入文本中 "now, today, yesterday" 出现两遍，属纯文本瑕疵；在尚无任何消息被注入的窗口期修复，零缓存代价

## 7. 已知边界

- 动态插件进程内生命周期：DSH 重启后需重新加载（`cordis_define` + `cordis_run`），配置持久化不受影响
- 注入消息与 compaction 的关系：被压缩掉属正常行为
- 子代理/API 驱动的会话：只要其会话 cwd 属于某工作区，同样受该工作区开关控制

## 8. 静态化移植（static/ 目录）

动态插件随进程重启消失（进程内注册表），因此移植为**普通组合插件**：一个 npm 包同时提供 Host 半部（main）与 Client 半部（`dsh.client` 声明 + `./client` bundle），组合里一行 `- id: dsh-time-stamp, name: 'dsh-time-stamp'` 即可同时挂载两端（client-modules 扫描 loader 条目中的 `dsh.client` 声明，把 `./client` 作为浏览器 bundle 供 `window.__DSH_BOOT__` 加载）。

### 8.1 存储：storageDomain → settings.register

动态沙箱**没有 import 能力**，只能用鸭子类型 schema 打开 storageDomain；静态包是正规 npm 包，直接 `settings.register('time-stamp', s.object({...}))`（schemastery），配置持久化到 `settings.yaml` 的 `time-stamp` 段，带 schema 校验与默认值，且用户可直接编辑文件。

### 8.2 客户端通道：harness.handle → webServer 路由

动态版客户端用 `host.call`（动态 runner 专属内置）；静态版没有该内置。候选方案对比（按实际验证结论）：

| 方案 | 结论 |
|---|---|
| `@Remote` / typert | ❌ 客户端 remote 注册表要求真实 zod v4 schema 实例，而浏览器运行时把 zod **内联**在 dsh-client-connection / dsh-api-remotes 的 bundle 里，模块表没有可 require 的 `zod`；手写包无法满足校验 |
| `settingsScope`（api.settings 通道） | ❌ **实测否决**：apiProxy 的 settings.describe 有硬编码白名单（`WEB_SETTINGS_NAMESPACES` / `PRODUCT_SETTINGS_NAMESPACES`，dsh-host-apiproxy），第三方命名空间一律 `settings-not-exposed`（源码注释明言"让插件通过 settings.register 自暴露是推迟的工作"）。Host 侧 describe 有 13 个命名空间，客户端只见 11 个，`time-stamp` 被过滤 → 快照永远 `unavailable` |
| webServer 路由 + fetch | ✅ 最终采用。Host 注册 exact 路由 `POST /dsh-time-stamp/api`（JSON `{method, args}`），客户端 `fetch` 同源调用——零白名单、零 typert、零 zod，与动态版 `host.call` 同构（state/set-enabled/get-default/set-default） |

调试经验：客户端通道问题可用**动态插件可视化探针**定位（注入 header 插槽，直接显示快照状态与直连 RPC 结果），比猜代码高效得多。

### 8.3 客户端 bundle 格式

浏览器 bundle 必须遵循 `window.__ModuleLoader__.load({id, factory})` 懒加载 CJS 格式（`exports.apply` + `exports.inject` 导出 cordis 插件），`require("react")` 取 React；本包只依赖 React，UI 全部用 `React.createElement` + 内联样式。

### 8.4 验证手段（无重启环境）

- `node --check lib/client.js`：bundle 语法
- 从安装位置 `import('lib/index.js')`：ESM 语法、依赖解析（向上走到 profile 共享层 node_modules）
- 可调用 schema 验证：`schema({})` → `{defaultEnabled: true, projects: {}}`（默认值生效）、`schema['~standard'].validate(...)`（Standard Schema 接口）
- 组合变更必须重启进程才能最终生效（本机由用户重启后验证）

### 8.5 动态/静态并存说明

两者不会同时注入：静态版需重启才加载，而重启即清空动态注册表。迁移时旧 `time_stamp.json` 变为无用文件（默认值一致，无需数据迁移），可手动删除。

## 9. dsh 0.2.x 兼容性移植（v1.1.0）

### 9.1 破坏性变更清单（以 npm 包源码为准，逐条核实）

| 变更 | 0.1.x | 0.2.x | 影响 |
|---|---|---|---|
| `settings.register(ns, schema)` | 有 | **移除** | 插件初始化直接抛 `TypeError` → 整条插件不激活 |
| `settings.get(ns)` | 有 | **移除** | 读配置无处可读 |
| 设置声明方式 | register 的 schema | 插件的 **`static Config`**（`describe()` 读 `entry.fiber.runtime.Config`） | 需暴露 Config |
| 设置命名空间 | 注册的 ns（`time-stamp`） | **组合条目标识**（`dsh-time-stamp`） | 写错 ns 抛 `No configurable plugin entry` |
| 可写字段 | 任意 | **仅 volatile 字段**（`schema.meta.volatile`），逐路径校验 | 需 `.volatile()` 标记 |
| `Session.events` | 有（数组） | **移除**，只有 `snapshotEvents(from?, to?)` / `eventAt(seq)` | 「距上一条消息」永久缺失（被守卫成静默） |
| 会话元数据 | `session.header`（`meta` 只是创建入参） | 同左 | **按工作区归属一直静默退化**（旧代码读 `session.meta`） |
| `agent/pre-step` | `{messages, turn, step, signal}` + `{kind:'enter', messages}` | **未变** | 注入点无需改 |
| `webServer.register({kind, path, handler})` | 同 | **未变** | 路由无需改 |

### 9.2 运行时特性检测（单一代码路径）

```
legacySettings = typeof ctx.settings.register === 'function'   // dsh <= 0.1.6
  true  → register(ns, schema) + get(ns) + mutate(ns, ops)
  false → static Config（volatile）+ 读自己的 config 引用 + mutate(entryId, ops)
```

- **volatile 标记**：`volatileField(schema)` 在 schemastery 有 `.volatile()` 时调用（3.18.5+），否则原样返回（3.18.2 老环境），保证同一份 schema 两代可用。
- **读值**：`currentValue(v)` 在 `v.get()` 存在时解包（`Volatile<T>` 包装，`updateVolatile` 是**原地写入**，因此同一实例读到的永远是最新值）。
- **条目 id**：优先 `ctx.get('configEditor').entries()` 中 `fiber === ctx.fiber` 的那行（与 Settings 服务同源），失败回退环境变量 `DSH_TIME_STAMP_ENTRY_ID`，再回退 `dsh-time-stamp`。
- **会话事件**：`session.snapshotEvents()` 优先、`session.events` 回退；每次注入调用一次快照（不在循环里）。
- **会话 cwd**：`session.header ?? session.meta`。

### 9.3 验证（本机 0.1.5 环境 + 新包源码）

- 老环境导入：`exports` 完整、`enabledFromConfig` 对 plain/volatile 两种配置均正确、schema 默认值正确、`renderClockText` 输出正确；
- 新环境（schemastery 3.18.5 + cosmokit）：`.volatile()` 存在、解析结果 `value.<field>.get()` 可读、`schema.dict.<field>.meta.volatile === true`（`volatileForm` 与 `isVolatilePath` 的前提）、`schema({projects:{ws:false}})` 的覆盖生效；
- 0.2.x 行号/契约与 issue 报告一致（`dsh-settings` 0.2.1-rc.5 `describe` 读 `entry.fiber.runtime.Config`、`write` 按 `entry.options.id` 找条目并校验 volatile 路径）。
