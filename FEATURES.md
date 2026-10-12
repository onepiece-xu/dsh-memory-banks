# 功能对等清单：pi-hermes-memory → dsh-memory-banks

上游参照：`pi-hermes-memory@0.9.10`（Pi 扩展，Hermes agent 记忆机制移植）。
本插件目标：在 DSH 0.2.0-rc.2 上用原生接缝实现同等能力，**不依赖 pi2dsh**。

状态：✅ 完成（有构建/单测/挂载证据） · 🔨 进行中 · ⬜ 待做 · ➖ DSH 无对应接缝（已用替代方案）

## 1. 记忆存储与预算

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| 双记忆库 MEMORY/USER | `MEMORY.md` / `USER.md` | bank `memory` / `user` | ✅ |
| 失败记忆库 | `failure` bank =2× memory 预算 | bank `failure`（默认 4400） | ✅ |
| 项目级两档记忆 | `~/.pi/agent/projects-memory/<project>/` | bank `project` + `project` 字段；`projectKeyOf(cwd)` = 目录名 + 路径哈希 | ✅ |
| `§` 分隔符 | `ENTRY_DELIMITER='\n§\n'` | 同名常量（`src/core.ts`） | ✅ |
| 字符预算 + 拒绝超额 | 三个 `*CharLimit` | `Config` + `assertWithinLimit`，错误带超出量与实时用量 | ✅ |
| 原子写 + 失败回滚 | temp+rename + 变更锁 | storage-domain 单写链 + 仓储层 diff-commit 回滚（有单测） | ✅ |
| 扩展存储（超 markdown 上限仍可检索） | SQLite `memories` 表 | storage-domain 7 张表；本地 zod 单测 | ✅ |
| 记忆老化/用量 | `hit_count`/`last_hit_at` | `memory_search` 命中即计数（`noteHits`），有单测 | ✅ |
| 写入来源可审计 | — | 每条记录带 `source`: tool/session/review/consolidation/import（按"本次写入"打标） | ✅ |

## 2. 模型工具（上游 6 个，同名同参）

| 工具 | 状态 | 说明 |
|---|---|---|
| `memory_add`（target/content/category?/failure_reason?/project?） | ✅ | 失败库的 `failure_reason` 追加为 `[reason: …]` |
| `memory_replace`（target/old_text/content/category?） | ✅ | 精确匹配优先，歧义报错 |
| `memory_remove`（target/old_text） | ✅ | 同上 |
| `memory_search`（query/project?/target?/category?/limit?） | ✅ | 每词都要命中；命中即记用量 |
| `session_search`（query/role?/limit?/snippet_chars?） | ✅ | 走宿主原生 `ctx.sessionQuery`；**索引默认关闭**，见 §3 |
| `skill_manage`（action/scope/name/description/skill_id/section/结构化字段） | ✅ | 存储域持久化 + `ctx.skills` provider 镜像；create 有重名/重 slug 守卫 |

> 早期骨架里的合并式 `memory` / `memory_list` 已删除，工具面与上游一致。

## 3. 会话历史检索（引擎选型：用宿主原生服务）

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| 会话历史全文检索 | 自建 SQLite FTS5 trigram 索引 | **➖ 改为消费 `ctx.sessionQuery`**，不再自建第二份索引 | ✅ |
| 分词器/召回 | trigram（CJK 3 字以上可子串匹配） | 宿主 `unicode61` 是 token 召回；插件补 **子串回退**：`sessionSearchMode: 'auto'` 在 token 命中为 0 且查询含短词（<3 字符）时，改用宿主文档化的字面扫描 `filterEvents([{kind:'text'}])`，扫描最近 N 个会话（`sessionSearchScanSessions`） | ✅ |
| 索引开关 | 插件自带 | 宿主默认 `path: ':memory:'` + `openAt: never` → **搜索默认不可用**；本包附 `enable-session-index.patch.yml` 显式开启 | ✅ |
| 手动批量导入 `/memory-index-sessions` | 命令 | 同名命令（报告会话数与记忆条数；索引与回填归宿主所有，插件不写该索引） | ✅ |
| Markdown→索引回填 `/memory-sync-markdown` | 命令 | ➖ 不需要（记忆不落 Markdown；宿主索引自带按 revision 的增量重建） | ➖ |
| 会话保留期清理 | `sessionRetentionDays`（只删 DB 行） | ✅ 同义：按天清理 `reviews`/`consolidations` 审计行（默认关闭，最多每天一次）；**记忆条目永不清理** | ✅ |
| 锚点式检索变体 | `sessionSearch.variant='anchors'` | ✅ 等价能力：`substring` 模式 = 字面子串扫描（大小写不敏感、空白弹性），`auto` 自动回退 | ✅ |

**为什么不自己建索引**：DSH 0.2.0-rc.2 已内置 `dsh-session-query-sqlite`（单所有者、`application_id` 校验、按 revision 增量重建）；再建第二份会重复索引、并且会与宿主的单所有者约束冲突。实测也确认 trigram 对 1–2 字中文漏召回。

## 4. 学习循环

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| nudge（10 轮 或 15 次工具调用） | `nudgeInterval`/`nudgeToolCalls` | `agent/pre-step` 折进提示消息（`MessageSourceMap` 自定义 `dsh-memory-banks` 类型），计数在 `session/event` | ✅ |
| 冻结快照注入（每会话一次） | 会话事件去重 | `memoryMode: 'legacy-inject'` 时 `agent/created` + `agent.inject(createUserMessage(...))`，WeakSet + 来源标记去重 | ✅ |
| 纠错即时捕获 | 强/弱模式 + 否定模式 | `classifyCorrection()`：强模式直接存、弱模式需跟指令词、表扬/无关忽略；`session/event` 扫 `user/message`，每会话上限 | ✅ |
| 后台复盘（LLM 产出记忆变更） | 进程内 `complete()` 旁路 / `pi -p` | ✅ `session/flush` 触发；`src/llm.ts` 用 `ctx.llm.stream` + `BlockAssembler` 做一次性调用（DSH 没有 `complete()`）；prompt + `validateReviewOperations()` 双重校验，按库分组原子落库，全程记 `reviews` 审计行 | ✅ |
| 自动整合（崩溃安全状态机） | `prepared→replacements-written→completed` | ✅ `consolidations` 表三态机 + 启动时 `recoverInterrupted()` 把非终态标失败；整合结果先过预算校验再 `replaceBank` 一次原子替换 | ✅ |
| 溢出策略 | `auto-consolidate`/`reject`/`fifo-evict` | ✅ `auto-consolidate`：写入因超预算被拒时自动整合并重试一次（`memoryOverflowStrategy` + `autoConsolidateOnOverflow`）；`reject` 保持直接报错 | ✅ |
| 整合分块 + 超时 | `consolidationChunkChars`/`consolidationTimeoutMs` | ✅ 分块多轮（`consolidationChunkChars`，每轮合并至少 2 条、计划写回审计行、全库不缩就直接停）；超时 180s | ✅ |
| 压缩前落盘 | `flushOnCompact` | ➖ DSH **没有 pre-compaction 钩子**（已核实：只有失败回退 `compaction/summary-error`）；可观察 `session/event` 的 `compaction/start`，但无法阻塞 | ➖ |
| 会话结束落盘 | `flushOnShutdown` + `flushMinTurns` | ✅ `session/disposed` 触发最后一次复盘（`flushOnSessionEnd`）；复盘是后台任务不阻塞 flush；同会话并发有互斥 | ✅ |
| `/memory-consolidate` 手动触发 | 命令 | ✅ 真实执行：可指定库，或默认对最满的库执行（<70% 时只报告） | ✅ |
| 运行中并发保护 | — | ✅ 同一会话的复盘、同一库的整合互斥（`busy` 守卫返回 skipped 而非交错写入）；坏实例重启后非终态行自动清理（有单测） | ✅ |

## 5. 技能（过程性知识）

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| `skill_manage` 增删改查 | Pi 原生 `SKILL.md` | ✅ 存储域 `skills` 表 + 结构化渲染（When to Use/Procedure/Pitfalls/Verification）+ `patch` 分区替换 + 长度上限 | ✅ |
| 技能被模型发现 | Pi `resources_discover` | ✅ `ctx.skills.registerProvider(...)`：`list()`/`get()` 直接读存储域，改完立即生效（`register()` 是 first-wins 且不能原地更新，故不用） | ✅ |
| 项目技能自动发现 | Pi `resources_discover` | ✅ provider 按 `project` 过滤；DSH 自带的 `$DSH_HOME/skills` 等来源不受影响 | ✅ |
| `/memory-skills` 管理 | TUI 多选 | ✅ 命令列出技能（增删改由 `skill_manage` 完成） | ✅ |
| `/learn-memory-tool` | 技能 | ✅ `/learn-memory-tool` 幂等创建全局技能 `using-dsh-memory-banks`（工具/命令契约），经 provider 立即可见 | ✅ |

## 6. 常驻指令（pin）

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| 每会话注入常驻指令 | `STANDING.md`，20 条/2000 字符预算 | ✅ `standing` 表 + 独立提示段（`maxStandingChars` 预算，超出部分截断） | ✅ |
| `/memory-pin`（增/列/删/清） | 命令 | ✅ 同名命令，支持 `list`/`remove <n>`/`clear` | ✅ |
| 模型不能自我提升为常驻 | 只允许用户/命令写入 | ✅ 工具面没有写 standing 的能力，只有命令能写；写入仍过内容扫描 | ✅ |

## 7. 安全与框架

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| 威胁模式（11 条） | `content-scanner.ts` | 11 条 | ✅ |
| 密钥模式（20 条，分级） | `SECRET_PATTERNS` | 20 条，high/medium 分级 | ✅ |
| 不可见字符检测 | `INVISIBLE_CHARS` | 零宽 + 双向控制符 | ✅ |
| 注入框架 + 守卫说明 | `<memory-context>` + "NOT new user input" | `fenceMemory()`（容器 + 守卫 + 转义 `</system-reminder>`） | ✅ |
| 写入前扫描拒写 | 是 | 6 个工具与 pin 全部走 `#assertScannable`，命中即拒（有单测） | ✅ |

## 8. 配置与界面

| 上游功能 | 上游实现 | 本插件实现 | 状态 |
|---|---|---|---|
| 配置项 | `dsh-memory-banks-config.json`（30+ 字段） | `Config` 19 字段，**全部 `.volatile()`** → 出现在 DSH Settings → Plugins 表单里 | ✅ |
| 命令 | 9 条 | 9 条：`/memory-insights` `/memory-pin` `/memory-preview-context` `/memory-switch-project` `/memory-consolidate` `/memory-interview` `/memory-index-sessions` `/memory-skills` `/learn-memory-tool`（上游第 9 条 `/memory-sync-markdown` 为 ➖） | ✅ |
| 设置页 | 无（靠文件） | Web 面板（`settings.section`）：各库用量条 + 条目 + 常驻指令 + 技能数，读 `GET /dsh-memory-banks/stats` | ✅ |
| 状态查看 | `/memory-insights` 文本 | 命令 + 面板 + HTTP 路由 | ✅ |

## 9. 多进程安全（尚未解决）

| 风险 | 状态 |
|---|---|
| storage-domain（`single` 布局）在每个进程各持一份权威内存，两个进程（web + headless）可互相覆盖 | ⬜ 已知风险，未修。可选方案：`withFileLock`（`@deepseek-ai/dsh-atomic-write`）包住域写入，或改用 `per-record` 布局 |
| 宿主会话索引要求"一个路径一个进程" | ✅ 已在 `enable-session-index.patch.yml` 中写明并默认不打开 |

## 只在真实宿主里才暴露的坑（已修）

| 现象 | 真因 | 修法 |
|---|---|---|
| 整个插件条目不激活，**所有工具消失** | cordis 读**未注入**的服务属性会抛 `cannot get property "X" without inject`；`ctx.get()` 也拿不到兄弟作用域的提供者 | 可选服务一律用 **`ctx.inject([...], cb)`**（回调里属性可访问；headless/SDK 里回调不执行，插件照常加载） |
| 面板「读取失败（宿主路由未就绪）」、路由 404 | 同上：`ctx.get('webServer')` 拿不到 web server | 同上，`ctx.inject(['webServer'], (webCtx) => webCtx.webServer.register(...))` |
| 预算失效、nudge 每步都响、复盘被疯狂触发（165 条 failed） | `.volatile()` 字段运行时是 **`{ get() }` 包装对象**（设置页可编辑的原因），被当成普通值使用 | `resolveConfig()` 归一化 + 做成**每次读取都解析**的视图，设置页改动即时生效 |

集成测试的假 Context 现在会复现这两点（未注入属性即抛错、配置传包装对象），所以这两类回归会直接测红。

## 关键决策记录

1. **不依赖 pi2dsh**：`pi2dsh@0.25.2` 的 DSH peer 上限是 `<0.2.0`，与本机 0.2.0-rc.2 不匹配。
2. **不引入 `better-sqlite3`**：DSH 原生服务已提供会话索引；记忆条数受限于有界库，检索用内存精确匹配更快且可在本地零依赖单测。
3. **逻辑与 DSH 解耦**：`core/records/repo/templates` 零 DSH 依赖（本地 45 个单测覆盖），`tools.ts` 只做参数映射，`index.ts` 只做接线 —— 接缝变了也只动一层。
4. **自定义 `MessageSourceMap` 类型**：DSH 的消息来源是合并可扩展的联合类型（"没有通用 plugin kind"），所以 `src/message-source.ts` 声明 `dsh-memory-banks`，这也让注入内容可被识别与去重。
5. **命令只在需要参数时声明 `input`**：声明 `input` 会让 `/cmd` + 回车变成"先认领再回车"，无参命令不值得这个代价。
6. **一次性模型调用用 `ctx.llm.stream` + `BlockAssembler`**：DSH 没有非流式入口；这是 `dsh-session-title-llm` 的同款做法。该调用是独立请求序列，**既不共享也不破坏**当前会话的前缀缓存。模型路由优先取 `llmProvider`/`llmModel` 配置，否则读 `agentDefaultModel.currentSelection()`；没有路由时复盘记为 skipped 而不是失败。
7. **复盘/整合不阻塞 flush**：`session/flush` 是并行 awaited 事件，处理器只投递后台任务（`void`），避免把耐久检查点拖成模型调用；代价是进程若立刻退出，当次复盘可能未完成（下次启动会把它标失败）。
8. **子串回退补 token 召回的缺口**：宿主索引是 `unicode61`（按 token），1–2 字中文会静默漏召回。`auto` 模式在 token 命中为 0 且查询含短词时改走宿主的字面 `text` 扫描。这是**唯一**的检索双路径，且只扫最近 N 个会话以控制成本。
9. **手动整合总是先合并一轮**：`/memory-consolidate` 的意图是"整理"，所以即使未超预算也合并一次；后续轮次只在仍超预算时继续。预算校验只作用于"覆盖整库"的那一轮（中间轮可以暂时超标）。
10. **保留期只清审计行**：`sessionRetentionDays` 清 `reviews`/`consolidations`，**永不清记忆条目** —— 条目是产品，审计是日志。

## 验证要求（每项都要）

1. `npm run build` 无错；`npm test` 全绿（当前 **78 项** = 69 纯逻辑 + 9 真实模块集成）
2. `dsh --profile dev --dump-config` 组合树正确
3. `dsh --profile dev --dump-config-schema` 导入模块无新增错误（与 stock `web` 的既有 8 条 carrier 报错数量一致）
3b. `tests/plugin.test.mjs`：真实模块 + 假 Context 跑 `apply()`，断言 6 工具/9 命令/2 提示段注册，并端到端执行工具、技能、pin、nudge、纠错路径
4. 涉及运行时行为的：`dsh --profile dev` 启动后确认（工具可见、命令可用、落盘文件正确）
