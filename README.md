# dsh-plugin-memory

> 仓库：<https://github.com/onepiece-xu/dsh-plugin-memory> · MIT

hermes-agent 那套**有界、持久**的记忆机制，做成 DSH 原生插件（不是 Pi 扩展、不需要 `pi2dsh` 桥）。

- **6 个模型工具**（与上游同名同参）：`memory_add` / `memory_replace` / `memory_remove` / `memory_search` / `session_search` / `skill_manage`
- **四个记忆库**：`memory` / `user` / `project` / `failure`，字符预算 + 超限拒写
- **持久化**：`ctx.storageDomain` → `$DSH_HOME/storages/dsh_plugin_memory.json`（人类可读、原子写、带版本戳、失败回滚）
- **两条学习路径**：nudge（10 轮或 15 次工具调用后提醒落盘）+ 纠错即时捕获（强/弱模式 + 否定模式）
- **后台复盘**：会话耐久检查点（`session/flush`）触发一次独立模型调用，产出经校验的记忆变更并分库原子落库
- **自动整合**：任何库写满时自动合并并重试一次；`/memory-consolidate` 可手动触发；崩溃中断的运行在下次启动被标记失败（同库/同会话并发有互斥）
- **常驻指令**：`/memory-pin` 写入的指令每会话注入，模型自己无法提升为常驻
- **过程性技能**：`skill_manage` 增删改查，通过 `ctx.skills` provider 暴露给模型
- **会话历史检索**：消费宿主原生 `ctx.sessionQuery`；`auto` 模式在 token 召回为空且查询含短词（<3 字符，如中文双字）时自动回退到宿主的字面扫描，补上 CJK 召回缺口
- **写入前扫描**：11 条威胁规则 + 20 条密钥规则（分级）+ 不可见字符，命中即拒写
- **9 条命令 + 32 项配置 + Web 面板**：配置全部 `.volatile()`，直接出现在 Settings → Plugins 表单里；`sessionRetentionDays` 只清审计行，记忆条目永不清理

## 结构

```
src/core.ts           纯逻辑：bank、§ 分隔、匹配、批处理、30 条扫描规则、记忆框架、projectKey（零依赖）
src/records.ts        zod 记录 schema：7 张表（零依赖，本地可单测）
src/repo.ts           仓储层：全部读写规则 + 预算 + 扫描 + 回滚（对 KV 表接口编程，内存可实现）
src/templates.ts      所有模型可见文本 + 纠错检测 + 复盘/整合 prompt + 技能渲染（零依赖）
src/json.ts           模型答案的 JSON 提取与条目读取（零依赖，可单测）
src/learning.ts       后台复盘 + 分块整合 + 崩溃恢复（零 DSH 依赖；模型调用是注入的）
src/search.ts         会话检索的判定与片段裁剪：何时回退到子串扫描（零依赖）
src/llm.ts            一次性模型调用适配（`ctx.llm.stream` + `BlockAssembler`）
src/tools.ts          6 个工具：只做参数映射，规则都在上面几层
src/storage.ts        defineDomain 声明（DSH 侧校验）
src/message-source.ts 声明本插件的 MessageSourceMap kind（DSH 的消息来源是合并可扩展联合类型）
src/index.ts          宿主半接线：domain / 工具 / 提示段 / nudge / 纠错 / 命令 / 面板路由 / 技能 provider
lib/client.js         浏览器半：settings.section 面板（手写 CommonJS 工厂，无需打包）
cordis.patch.yml      bundle 层 + 默认预算
enable-session-index.patch.yml  可选 overlay：打开宿主的会话历史索引
tests/                node:test 单测：78 项（纯逻辑 + 真实模块接线集成测试）
FEATURES.md           与 pi-hermes-memory 的逐项对等清单与进度
```

`tests/plugin.test.mjs` 会 **import 构建产物并用假 Context 跑 `apply()`**：6 个工具经真实 `defineTool` 校验注册、9 条命令与 2 个提示段就位，然后端到端执行 `memory_add → search → replace → remove`、技能增删、pin→常驻段、以及 nudge/纠错路径。这是本地能做的"最接近启动一次"的验证。

> 为了让这个集成测试在本地能 import 构建产物，`devDependencies` 里带了 `@deepseek-ai/dsh-scope` / `dsh-invariants` / `dsh-agent` / `dsh-storage` 等 core peer —— 它们**只在开发与测试时需要**，运行时由 DSH 安装侧提供。

### 两个只在真实宿主里才暴露的坑（已修，别踩回去）

1. **可选服务只能用 `ctx.inject([...], cb)`**：cordis 读一个没注入的服务属性会抛 `cannot get property "X" without inject`，整个插件条目不激活（表现：工具全没了）；`ctx.get('webServer')` 也到不了兄弟作用域的提供者（表现：面板路由 404）。headless/SDK 里 `ctx.inject` 的回调不执行，插件照常加载。
2. **`.volatile()` 字段运行时是 `{ get() }` 包装对象**：这是设置页能编辑它们的原因。直接当值用会让预算 / nudge 阈值 / 节流 / 搜索条数变成对象或 NaN（表现：预算失效、nudge 每步都响、复盘被疯狂触发）。`resolveConfig()` 归一化 + 每次读取都解析，设置页改动即时生效。

假 Context 现在会复现这两点，回归会直接测红。

## 六个工具

| 工具 | 参数 |
|---|---|
| `memory_add` | `target`(memory\|user\|project\|failure), `content`, `category?`, `failure_reason?`, `project?` |
| `memory_replace` | `target`, `old_text`, `content`, `category?` |
| `memory_remove` | `target`, `old_text` |
| `memory_search` | `query`, `project?`, `target?`, `category?`, `limit?` |
| `session_search` | `query`, `role?`, `limit?`(1..20), `snippet_chars?`(100..4000) |
| `skill_manage` | `action`(create\|view\|patch\|update\|delete), `scope?`, `name?`, `description?`, `skill_id?`, `section?`, `when_to_use?`, `steps?`, `pitfalls?`, `verification?`, `content?` |

## 四个记忆库

| bank | 放什么 | 默认预算 |
|---|---|---|
| `memory` | 环境/工具/项目怎么运作 | 2200 chars |
| `user` | 用户是谁、偏好、沟通方式 | 1375 chars |
| `project` | 当前仓库约定（按 cwd 归属） | 2200 chars |
| `failure` | 做过什么、为什么不行 | 4400 chars |

预算是**字符**不是 token；超预算的写入被拒绝，错误里给出超出量与该库实时用量。精确匹配优先，`old_text` 命中多条时直接报错，绝不猜。

## 会话历史检索需要显式开启

DSH 内置的会话索引在 0.2.0-rc.2 默认是关的（`session-query-sqlite`：`path: ':memory:'` + `openAt: never`），所以 `session_search` 默认会返回一条可执行的错误提示。开启方式：

```sh
dsh --profile web --patch ./enable-session-index.patch.yml
```

注意：该索引**一个路径只能由一个进程拥有**（web 与 headless 不要共用），且召回是按 token 匹配（`unicode61`），不是任意子串。

## 本地开发

```sh
npm install
npm run build          # tsc → dist/
npm test               # 构建 + 45 项 node:test 单测

# 装进一个丢弃式 profile（不要用 web，避免打断正在跑的 GUI）
dsh --profile dev --from-default-profile web --dump-config
dsh plugin --profile dev add link:D:\Codes\dsh-plugins\dsh-plugin-memory
dsh --profile dev --dump-config | Select-String dsh-plugin-memory
dsh --profile dev --dump-config-schema        # 真实导入本插件模块 + 校验 Config
dsh --profile dev                              # 启动后即可用工具与命令
```

改配置即时生效（HMR 监听 profile patch 文件）；**改源码需要重启**，除非在 profile patch 里放开 `- id: hmr` 的 `config.root: ["."]`。

## 验证状态

已验证：

- `npm run build` 通过；`npm test` **78/78** = 69 项纯逻辑单测 + **9 项真实模块集成测试**（工具/命令/提示段注册断言，`memory_add→search→replace→remove` 端到端，技能增删，pin→常驻段，nudge 与纠错路径，会话检索不可用时的可执行提示）
- `dsh --profile dev --dump-config` 出现 `- id: dsh-plugin-memory` 及其 config
- `dsh --profile dev --dump-config-schema` **真实导入**本插件（含 `dsh-llm` 运行时依赖）并产出 19 个配置字段的 schema；新增错误 0（与 stock `web` 的既有 8 条 carrier 报错数量一致）

尚未验证（需要真正启动一次）：工具是否出现在模型工具表、命令是否可用、nudge/纠错是否按预期触发。落盘检查 `~/.dsh/storages/dsh_plugin_memory.json`。

> **不要在项目目录里直接 `node dist/index.js`**：`@deepseek-ai/dsh-tools` 自身依赖 11 个 core peer（`dsh-scope`、`dsh-invariants` 等），只在 DSH 安装侧提供。插件的正式入口是 DSH loader；跑独立脚本请只 import 零依赖的 `dist/core.js`、`dist/repo.js`、`dist/templates.js`、`dist/records.js`。

## 与上游的取舍

| pi-hermes-memory | 本插件 |
|---|---|
| MEMORY.md / USER.md 文件 | storage-domain JSON（`$DSH_HOME/storages/dsh_plugin_memory.json`），人类可读 |
| 自建 SQLite FTS5 trigram 会话索引 | **不自建**：消费宿主 `ctx.sessionQuery`（避免重复索引与单所有者冲突）；代价是召回按 token，1–2 字中文需要实测 |
| 后台复盘 / 自动整合（进程内 `complete()` 旁路） | 已实现，但走 `ctx.llm.stream` + `BlockAssembler`（DSH 没有 `complete()`），复盘在 `session/flush` 投递为后台任务；该调用是独立请求序列，不影响当前会话的前缀缓存 |
| 压缩前落盘 `flushOnCompact` | DSH 没有 pre-compaction 钩子（核实：只有失败回退 `compaction/summary-error`），无法阻塞；只能观察 |
| Pi TUI 渲染 / `pi.registerCommand` | DSH 命令是纯文本返回；富交互走客户端 bundle（本插件有 settings 面板） |

## 发布注意

- **npm 上 `dsh-plugin-memory` 这个名字已被占用**（`latest` 0.9.3，不是本仓库）。要发布到 npm 请用 scope，例如把 `name` 改成 `@onepiece-xu/dsh-plugin-memory`，或换一个未占用的名字。目前本仓库以**源码/Git 安装**方式维护即可：
  ```sh
  dsh plugin --profile web add link:/path/to/dsh-plugin-memory   # 本地开发
  dsh plugin --profile web add github:onepiece-xu/dsh-plugin-memory   # 从 GitHub 装
  ```
- `peerDependencies` 必须**包含运行中的 DSH 版本**：装包前会校验 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的范围，不匹配直接拒绝（例外：`dsh plugin allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk`）。
- npm 上 `@deepseek-ai/dsh-tools` 的 `latest` 是过期的 `0.0.1-rc.1`，必须钉 `0.2.0-rc.2`（`next` 标签）。
