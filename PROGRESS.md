# 实施进度 (PROGRESS.md)

| 任务号 | 描述 | 新增/修改文件 | 测试状态 | 完成时间 |
|---|---|---|---|---|
| M0-T1 | 运行时探测与环境验证 | `scripts/probe.mjs`, `NOTES.md` | 已通过 probe 验证 | 2026-11-04 |
| M0-T2 | 注入路径与协议验证 | `probe/probe-inject.ts`, `NOTES.md` | 已核实协议与多帧结构 | 2026-11-04 |
| M0-T3 | 项目骨架与规范就绪 | `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/types.ts`, `src/config.ts`, `src/dsh/plugin.ts`, `src/index.ts`, `test/config.test.ts` | 6 tests passed | 2026-11-04 |
| M1-T1 | 数据库封装与迁移系统 | `src/core/db.ts`, `src/core/migrations/001_init.sql`, `test/core/db.test.ts` | 11 tests passed | 2026-11-04 |
| M1-T2 | 文本切分、Token估算与Scope | `src/core/text.ts`, `src/core/tokens.ts`, `src/core/scope.ts`, `test/core/text.test.ts`, `test/core/tokens.test.ts`, `test/core/scope.test.ts` | 30 tests passed | 2026-11-04 |
| M1-T3 | 核心写入流水线与版本管理 | `src/core/privacy.ts`, `src/core/writer.ts`, `test/core/writer.test.ts` | 42 tests passed | 2026-11-04 |
| M1-T4 | 只读查询与统计接口 | `src/core/store.ts`, `test/core/store.test.ts` | 46 tests passed | 2026-11-04 |
| M2-T1 | 接入管线与规则抽取 | `src/ingest/rules.ts`, `src/ingest/queue.ts`, `src/dsh/session-listener.ts`, `test/ingest/rules.test.ts`, `test/ingest/queue.test.ts` | 59 tests passed | 2026-11-04 |
| M2-T2 | 在线召回系统与融合打分 | `src/retrieval/query.ts`, `src/retrieval/channels.ts`, `src/retrieval/fuse.ts`, `src/retrieval/governor.ts`, `src/retrieval/render.ts`, `src/retrieval/recall.ts`, `test/retrieval/*.test.ts` | 118 tests passed (p95=21.91ms) | 2026-11-04 |
| M2-T3 | 宿主集成、提示词注入、工具与命令 | `src/dsh/prompt-section.ts`, `src/dsh/pre-step.ts`, `src/dsh/tools.ts`, `src/dsh/commands.ts`, `src/dsh/plugin.ts`, `test/dsh/*.test.ts` | 138 tests passed (全量通过) | 2026-11-04 |
| M2-T4 | 历史会话回填与 zstd 多帧流式解压 | `src/ingest/backfill.ts`, `src/dsh/commands.ts`, `test/ingest/backfill.test.ts` | 146 tests passed (全量通过) | 2026-11-04 |
| M3-T1 | 离线 LLM 账本、客户端、安全脱敏与输出解析 | `src/evolution/types.ts`, `src/evolution/ledger.ts`, `src/evolution/prompts.ts`, `src/evolution/parse.ts`, `src/evolution/llm.ts`, `test/evolution/*.test.ts` | 174 tests passed | 2026-11-04 |
| M3-T2 | 离线任务调度器与互斥执行器 | `src/jobs/types.ts`, `src/jobs/runner.ts`, `src/jobs/scheduler.ts`, `test/jobs/scheduler.test.ts` | 180 tests passed | 2026-11-04 |
| M3-T3 | 会话抽取器 (distill-v2 连续有界选批) | `src/evolution/extractor.ts`, `test/evolution/extractor.test.ts` | 184 tests passed | 2026-11-04 |
| M3-T4 | 结果判定与失败反思 (reflect-v2 / outcome) | `src/evolution/outcome.ts`, `src/evolution/reflector.ts`, `test/evolution/outcome.test.ts`, `test/evolution/reflector.test.ts` | 187 tests passed | 2026-11-04 |
| M3-T5 | 知识巩固与日常维护 (consolidate-v2 / maintenance) | `src/evolution/consolidator.ts`, `src/evolution/maintenance.ts`, `test/evolution/consolidator.test.ts`, `test/evolution/maintenance.test.ts` | 195 tests passed | 2026-11-04 |
| M4-T1 | 评测执行器与指标体系 | `src/eval/types.ts`, `src/eval/metrics.ts`, `src/eval/runner.ts`, `test/eval/metrics.test.ts`, `test/eval/runner.test.ts` | 203 tests passed | 2026-11-04 |
| M4-T2 | 评测集生成器 (120用例, 4大Suite, 20 Critical) | `src/eval/gen-dataset.ts`, `test/eval/dataset.test.ts` | 208 tests passed | 2026-11-04 |
| M4-T3 | 评测 CLI 与 /memory eval 门禁基线验证 | `src/eval/eval-cli.ts`, `src/dsh/commands.ts`, `tsup.config.ts`, `package.json` | 97.2% Recall, 0 ExclViol, MVP 全部门槛达标 | 2026-11-04 |
| M5-T1 | 检索策略版本化与配置约束 | `src/evolution/strategy.ts`, `src/retrieval/recall.ts` | 自动约束 dynamicCap 与权重归一化 | 2026-11-04 |
| M5-T2 | 策略进化实验室与哨兵回滚 (EvolveMem) | `src/evolution/lab.ts`, `test/evolution/lab.test.ts` | 213 tests passed, 哨兵回滚与关键用例保护验证完毕 | 2026-11-04 |
| M5-T3 | 收获用例自动采集与沉淀 | `src/evolution/lab.ts`, `src/evolution/outcome.ts`, `test/evolution/lab.test.ts` | 219 tests passed, 确认反馈与使用记忆落盘 | 2026-11-04 |
| M6-T1 | 查询触发修复流水线与提案审批 (RIME / repair-v2) | `src/evolution/repair.ts`, `src/dsh/commands.ts`, `test/evolution/repair.test.ts` | 219 tests passed, revise/split/invalidate/keep 全分支验证完毕 | 2026-11-04 |
| §8.4 & §10 | MVP 全量验收清单、回归门禁与安全备份恢复 | `src/evolution/maintenance.ts`, `src/dsh/commands.ts`, `test/acceptance.test.ts` | 230 tests passed (全量通过，100% 验收达标) | 2026-11-04 |
| 宿主挂载与端到端实机激活 | DSH Desktop 接入、标准 Schema 协议对齐与冷热重载 | `src/dsh/plugin.ts`, `~/.dsh/profiles/desktop/cordis.patch.yml` | 230 tests passed, DSH 动态热加载成功，`memory.db` 实体初始化成功 | 2026-11-04 |
| v0.2.0-T1 | 记忆健康体检医生 (`health.ts`) 与本地零依赖混合向量通道 (`vector.ts`) | `src/core/health.ts`, `src/core/vector.ts`, `src/retrieval/channels.ts`, `test/core/health.test.ts`, `test/core/vector.test.ts` | 280+ tests passed | 2026-11-06 |
| v0.2.0-T2 | 双环闭环增强 (`pre-step` 遥测与活跃策略绑定、RIME 负向自动触发、慢环全处理器挂载) | `src/dsh/pre-step.ts`, `src/evolution/outcome.ts`, `src/dsh/tools.ts`, `src/dsh/plugin.ts`, `src/dsh/commands.ts` | 280+ tests passed | 2026-11-06 |
| v0.2.0-T3 | Glassmorphism Web UI 控制台升级 (体检冲突去重、Mem0 调和沙盒、双向拓扑关联) | `src/dsh/web.ts`, `src/client/api.ts`, `src/client/types.ts`, `src/client/components/{MemoryHeader,RecallSandboxView,EvolutionView,MemoryDetailModal}.tsx` | 281 tests passed, client.js 构建通过 | 2026-11-06 |
| v0.3.0-T1 | 128D 向量即时 LRU 内存兜底与自动回填 (`getOrComputeEmbedding`) + GraphRAG 1-Hop 拓扑激活扩散与关系协同增益 (`expandGraphNeighbors`, `getSubgraph`) | `src/core/vector.ts`, `src/retrieval/channels.ts`, `src/retrieval/fuse.ts`, `src/retrieval/recall.ts`, `src/core/store.ts`, `test/core/vector.test.ts`, `test/core/graph.test.ts` | 284 tests passed | 2026-11-06 |
| v0.3.0-T2 | 记忆健康医生一键智能自愈 (`autoHealMemoryHealth`) 与 128D 语义冗余检测 + Glassmorphism 工作台生产力升级 (批量审批/确认、内联建边、一键自愈与聚类巩固) | `src/core/health.ts`, `src/dsh/{tools,commands,plugin,web}.ts`, `src/client/**`, `test/core/health.test.ts` | 284 tests passed (48 Suites), 100% MVP 评测门禁通过 | 2026-11-06 |
| v0.4.0-T1 | 融合 2025-2026 最新论文算法：SYNAPSE 扇出注意力衰减与 2-Hop 阻尼激活扩散 (`computeFanAttenuation`, `expandGraphNeighbors`) + ACT-R 间隔重复频次强化激活 (`computeActRBaseActivation`) + A-Mem 卡片盒动态双链织网 (`weaveZettelkastenLinks`, `upsertCandidate`) | `src/retrieval/channels.ts`, `src/retrieval/fuse.ts`, `src/core/writer.ts`, `src/core/health.ts` | 291 tests passed | 2026-11-07 |
| v0.4.0-T2 | 安装后与首次启动全自动记忆初始化引擎 (`autoBootstrapMemory`, `scripts/postinstall.mjs`, `/memory init`, `memory` 工具 `init` 动作及 Web UI 一键初始化按钮) | `src/core/bootstrap.ts`, `scripts/postinstall.mjs`, `package.json`, `src/dsh/{plugin,commands,tools,web}.ts`, `src/client/**`, `test/core/bootstrap.test.ts` | 291 tests passed (49 Suites), 120 用例评测 97.2% Recall (p95=0.8ms) | 2026-11-07 |
| v0.5.0-T1 | 清理冗余探针与薄封装模块 (移除 `src/dsh/turn-stopping.ts`, `probe/probe-inject.ts`, `scripts/probe.mjs`, `scratch/`) + 形态学词干与复合词匹配 (`stemToken`, `isTokenMatch`) + 中文疑问助词边界降噪 + 写入期 128D 向量缓存即时预热 (`primeRuntimeVectorCache`) | `src/dsh/plugin.ts`, `src/core/text.ts`, `src/retrieval/query.ts`, `src/core/vector.ts`, `src/core/writer.ts`, `src/retrieval/channels.ts` | 消除 Factual 套件词形失配与新旧嵌入混合盲区 | 2026-11-07 |
| v0.5.0-T2 | 前沿论文深度算法演进：HippoRAG 2 多源汇聚 PPR 激活累加 (`fuse.ts`) + LightMem 次模 MMR 边际去重装箱 (`computeMmrMarginalScore`) + Zep/Mem0 规范槽位推演与向量-词法混合调和 (`reconciler.ts`) + 哨兵动态策略版本绑定与高饱和帕累托进化 (`outcome.ts`, `lab.ts`) | `src/retrieval/{fuse,governor}.ts`, `src/evolution/{reconciler,outcome,lab}.ts`, `src/eval/gen-dataset.ts`, `src/client/components/MemoryHeader.tsx`, `test/**` | 295 tests passed (49 Suites), 120 用例全量 100.0% Recall (120/120, p95=0.8ms) | 2026-11-07 |
| v0.6.0-T1 | 全自动生命周期闭环升级 (`Autonomous Doctor & Turn-Stopping Orchestrator`)：自愈引擎自动应用已验证 RIME 修复提案 (`repairsApplied`)、自动晋升高置信度候选记忆 (`candidatesPromoted`)、保存模型配置自动开启后台进化授权，并在 `turn-stopping` 与轮询周期全自动编排 `distill` / `consolidate` / `maintain` / `evolve` | `src/core/health.ts`, `src/dsh/plugin.ts`, `src/dsh/web.ts`, `test/core/health.test.ts` | 296 tests passed (49 Suites) | 2026-11-07 |
| v0.6.0-T2 | `Nwflower/dsh-claude-style` Studio UI 重构与全局单按钮极简控制台：全局严格仅保留唯一「模型配置」按钮（配置浮层采用 550ms 防抖自动热保存与自动连通检测，零其余按钮），直连 `--dsw-alias-*` / `--dsh-claude-*` 设计令牌、衬线标题、3×2 Overview 遥测面板与 Process-Column `<details>` 折叠记忆流 | `src/client/styles.ts`, `src/client/MemoryApp.tsx`, `src/client/components/{MemoryHeader,LLMConfigModal,GlassUI,StatCards,MemoryCard,MemoryDetailModal,CoreMemoryView,EvolutionView,RecallSandboxView,GraphView}.tsx`, `package.json` | 296 tests passed (49 Suites), `dist/client.js` 构建通过, 120 用例 100.0% Recall | 2026-11-07 |
| v0.7.0-T1 | 写入期同步 128D 向量持久化与混合次模 MMR 升级：在 `insertNewRecord` / `editContent` / `rollback` 事务内同步落盘 512B `Float32Array` 嵌入并消除大规模库 >150 条冷启动盲区（`recallVector` Top-400 效用优先扫描）+ 层级目录前缀与中文 3-gram 特征增强 + 词法-语义混合次模 MMR 装箱（`computeHybridOverlap`）+ `memory_search` 全量七路融合检索与 `memory_expand` 1-Hop 因果关系透出 | `src/core/vector.ts`, `src/core/writer.ts`, `src/retrieval/{channels,governor}.ts`, `src/dsh/tools.ts`, `test/core/{writer,vector}.test.ts`, `test/retrieval/governor.test.ts` | 302 tests passed (50 Suites) | 2026-11-07 |
| v0.7.0-T2 | 慢环闭环漏洞根治、Core Memory 自主同步与极简 Studio UI 精炼：修复多轮会话静态 `distill` 任务键死锁（升级为水位线序列键 `${sessionId}:seq:${minSeq}`）、接入蒸馏产物的 Mem0 调和闭环（修复 `reconciler` 哈希 `workspaceId` 匹配与演进锚点）、修复 `harvested` 评测样本计数 SQL 表名错位、新增高验证记忆幂等晋升 Letta Core Memory（`syncAutonomousCoreMemory`）与全字段无损 `.db` 导入、补齐 `/api/dsh-memory/core` 路由与二进制 `embedding` 剥离、精炼零额外按钮 Studio UI（被动 `<input type="search">` 检索、`DSH 宿主内置模型` 预设、真实稳定层 Token 标尺）并清理 14 个遗留冗余前端文件 | `src/evolution/{reconciler,extractor,maintenance}.ts`, `src/core/health.ts`, `src/dsh/{plugin,web}.ts`, `src/client/{index,MemoryApp,styles,types}.ts*`, `src/client/components/LLMConfigModal.tsx`, `test/v070-features.test.ts`, `package.json`, `README.md` | 302 tests passed (50 Suites), `dist/client.js` 零额外按钮校验通过, 120 用例 100.0% Recall | 2026-11-07 |
| v0.7.1-T1 | 安全加固与缺陷修复：Web API 拒绝 `Origin: null` 与 DNS Rebinding Host、POST 强制 `application/json`（阻断简单请求 CSRF）、413 请求体超限；配置接口校验 Base URL / 密钥环境变量名白名单（防任意环境变量外泄）、端点跨源变更清除密钥绑定；LLM 客户端响应体读取纳入超时、失败响应体排空、429/5xx 指数退避；模型信任边界（`memory_confirm` 不可自我批准无用户证据的候选、非可信 reconcile 不再归档/取代有效记忆、非用户不得合并 frozen/pinned 记忆）；`reconcile` 工具 kind 映射修复 CHECK 崩溃；编辑操作原子化、批量操作校验与真实计数、导入上限与单事务、LIKE 通配符转义、导出 N+1 消除；IngestQueue 单条坏事件隔离与失败重入队、调度器 unhandledRejection 防护；遥测/任务表索引；新增厂商密钥脱敏规则；CI 环境跳过 postinstall 引导 | `src/dsh/{web,tools,commands}.ts`, `src/evolution/{llm,reconciler}.ts`, `src/core/{writer,privacy,db}.ts`, `src/ingest/queue.ts`, `src/jobs/scheduler.ts`, `scripts/postinstall.mjs`, `test/security-hardening.test.ts`, `test/dsh/advanced-features.test.ts` | 339 tests passed (52 Suites)，typecheck 与 build 通过 | 2026-11-10 |
| v0.7.1-T2 | 性能瓶颈根治与架构稳态保障：引入 pure-JS `fzstd` 作为跨平台 zstd 多帧与撕裂帧流式解压兜底，避免非原生 Node 环境崩溃；检索层优化短码碰撞检测（B-Tree 前缀聚合查询，消灭 N 次逐条 SQL 查询）、预算装箱中间态免数据库查询（仅终态严格校验，避免贪心循环触发上百次短码回表）；关系表新增 `ix_rel_type(rel, from_id, to_id)` 联合索引，将矛盾关系检索从全表扫描降至单次索引点查（10k 记忆检索耗时从 249.5ms 骤降至 10.13ms，提升 24+ 倍）；知识巩固（consolidator）写入事务包装容错防止未捕获异常崩溃；修复修复提案批准（repair proposal approve）中旧记忆向量缓存残留清理 | `src/ingest/backfill.ts`, `src/retrieval/{render,governor,recall}.ts`, `src/core/{db,migrations/001_init.sql}`, `src/evolution/{consolidator,repair}.ts`, `test/retrieval/recall.test.ts` | 339 tests passed (52 Suites), p95=10.13ms (远低于 50ms 门禁), typecheck 与 build 100% 通过 | 2026-11-10 |
| 审查修复 2026-11-11 | 修复离线隐私、Cookie 脱敏、重定向越权、模型写入范围与并发保护、自批准、WAL 备份、重试唤醒、压缩可见性与零预算共 10 项问题；补充来源归属迁移和插件测试隔离 | `src/core/`, `src/dsh/`, `src/evolution/`, `src/ingest/queue.ts`, `src/jobs/scheduler.ts`, `src/retrieval/recall.ts`, `src/eval/runner.ts`, `test/` | `npm run check`: 56 suites / 404 tests；`npm run build` 通过；`npm run eval`: 120/120，关键用例 20/20，排除违规 0；万条检索 p95=11.60ms；`git diff --check` 通过 | 2026-11-11 |
| 审查优化复核 2026-11-11 | 修复工具作用域绕过、核心记忆免审批、合并证据转移、提案部分提交、摄入故障丢事件与忙重试、后台失败分类和工具统计偏差；优化稳定层装箱与注册失败恢复 | `src/core/{store,core-memory,writer,markdown}.ts`, `src/dsh/{tools,commands,plugin,prompt-section}.ts`, `src/evolution/{reflector,repair}.ts`, `src/jobs/types.ts`, `src/ingest/queue.ts`, `test/` | 新增 87 项回归；`npm run check`: 59 suites / 491 tests；`npm run build` 通过；`npm run eval`: 120/120；500 条置顶渲染 22.22ms，万条检索 p95=7.08ms | 2026-11-11 |
| v0.8.0 冒烟修复与发布 | 修复 Cordis 未注入 `ctx.agent` 报错、`session.header.cwd` 工作区丢失、超长/NULL-turn 轮次 `reflect` 超预算失败，以及 `skill-catalog`/`time-context`/`tool-jobs` 合成消息污染；升级 `0.8.0` 并合并发布 | `src/dsh/{plugin,session-listener,pre-step,web}.ts`, `src/evolution/{reflector,extractor}.ts`, `src/ingest/{backfill,rules}.ts`, `package.json`, `test/{dsh/live-smoke-regressions,evolution/reflector,ingest/backfill}.test.ts` | 新增 14 项冒烟回归（共 60 suites / 505 tests）；`npm run check` / `build` / `eval` 全绿通过 | 2026-11-11 |

## 2026-11-11 审查修复验证

分支：`codex/fix-audit-regressions`。本次仅完成本地修复、构建与验证，未提交、推送或部署。

| # | 修复内容 | 当前验证证据 |
|---|---|---|
| 1 | 所有离线入口检查实际数据归属；共享记忆按来源过滤；SQL 在 LIMIT 前排除私有记录 | `audit-boundaries.test.ts` 覆盖 distill、curate、reflect、repair、consolidate 和错误 cwd；来源日志清理后仍拦截 |
| 2 | 整条 Cookie / Set-Cookie 头脱敏 | `privacy.test.ts` 覆盖 HTTP、JSON、curl、数组；摄入到外发集成测试 |
| 3 | 离线请求和 Web 连通测试禁止自动跟随重定向 | 双本地 HTTP 服务证明 307 目的端收到 0 次请求；Web 路由断言手动处理重定向 |
| 4 | discard、supersede、absorb、slot 替换仅操作实际送审且归属一致的记忆 | 外部工作区 ID、共享记忆跨归属替换和新槽位占用回归 |
| 5 | 模型响应返回后，在写事务中重新验证内容、版本、状态和置顶标记 | 并发编辑、冻结、置顶、受保护槽位测试；替换失败保留旧 active |
| 6 | 模型确认、自动治理和修复不能凭自身置信度或成功次数批准候选 | assistant note → confirm → heal、curate、repair 仍为 candidate；旧修订用户证据无效；显式用户批准仍有效 |
| 7 | 备份、导出和导入前快照统一使用 VACUUM INTO、只读校验和原子发布 | WAL 中已提交数据可恢复；快照失败中止导入并保留旧备份；移除主文件复制兜底 |
| 8 | 调度器按 next_eligible_at 自动重新唤醒 | 无新 turn 时的 60 秒/600 秒重试、次日预算恢复、启动恢复、互斥竞争和停止取消 |
| 9 | 去重从已提交消息投影重建；仅实际 surface replacement 移除被覆盖引用；提交后才计入注入统计 | 失败/取消压缩、局部替换、重复引用、重启/fork 重折叠、新内容修订、未提交消息和幂等提交 |
| 10 | 稳定层、动态层、策略、评测和 Web 展示保留显式 0 预算 | 独立动态零预算和稳定零预算回归；120 条合成评测通过 |

数据库 schema 升至 2，新增持久化 `session_workspace_owners`；现存原始事件自动回填，数据库导入保留来源归属。配置排除工作区时，已丢失来源归属的旧共享记忆暂停离线外发。

投影使用 `zod` 状态校验，兼容 `stateOf` 和旧版 `snapshot` 读取接口；缺少可用投影时跳过动态注入。宿主接口按附录和发布包契约核对，并通过模拟宿主回归；本次未进行 DSH Desktop 实机重载验证。

测试使用内存库、临时目录、合成数据和本地 HTTP 服务。bootstrap 测试将用户主目录隔离到临时目录，避免读取真实 DSH 会话。

## 2026-11-11 审查优化复核

在上述 404 项测试基线上继续审查，保留工作区已有修改。以下是本轮新增修复，不重复计入上一轮结果。

| 优先级 | 问题与修复 | 验证证据 |
|---|---|---|
| P1 | 完整 ID 曾绕过作用域，短码忽略会话边界；统一 workspace/session 过滤，关系摘要在 LIMIT 前过滤，移除 history/rollback/restore 的原始 ID 兜底；保留明确无作用域的管理查询 | `tool-boundaries.test.ts` 覆盖完整/短 ID、其他会话、共享记忆、关系过滤、命令与反馈边界 |
| P1 | 模型调用 core set/append 曾按用户授权直接创建或覆盖核心记忆；现在写入待审批候选，保留原 active/frozen 内容与真实来源，返回提案 ID | 三种核心块、现有/冻结块、自我确认拒绝及显式用户审批回归 |
| P1 | 合并可把旧记忆的用户证据转给模型候选；禁止跨归属、受保护目标和 active 到 candidate 等不安全合并，仅转移当前正文修订的来源 | `tool-boundaries.test.ts` 合并证据与归属回归 |
| P1 | 拆分审批在后续校验失败时已修改前面的槽位记录；先校验全部候选再写入，并检查候选归属、重复 ID 和自动审批的置顶槽位保护 | `repair.test.ts` 新增 8 项：冻结/重复槽位/失效候选不留修改或版本快照；跨工作区与置顶保护；有效拆分完整落地 |
| P1 | 摄入将数据库 I/O 错误当作坏事件跳过，失败批次还会立即反复重试；仅隔离约束错误，其余整批回滚并重入队，由既有周期定时器重试 | `queue-recovery.test.ts` 验证第二条写入失败时两条均保留、恢复后入库；锁库 100ms 内仅尝试一次 |
| P2 | 稳定层逐条剔除并反复渲染导致延迟增长；按效用排序后二分寻找满足字节预算的后缀，保持 ID 顺序；提示词注册成功后才发布可见引用 | `prompt-section.test.ts` 验证 500 条置顶、最高效用保留、600 字节硬预算、注册失败后重试；本次全量测试渲染 22.22ms |
| P2 | 工具搜索在裁剪前记入注入统计，展开超限失败仍可被反馈；改为输出通过预算校验后才记录实际返回引用 | `tool-boundaries.test.ts` 验证被裁剪项与失败展开不落统计且无法反馈 |
| P2 | 离线处理器对预算/临时错误处理不一致，巩固和维护可能误报完成；统一为预算次日恢复、网络/超时/429/5xx 退避重试、配置/解析等错误停止自动重试 | `job-failures.test.ts` 60 项测试覆盖真实插件注册的 6 类处理器与 runner 落库状态、错误原因和恢复时间；仅模拟 LLM 返回值 |

最终验证：

- `npm run check`：类型检查通过，59 个测试文件、491 项测试全部通过。
- `npm run build`：服务端 ESM、类型声明和客户端 bundle 均构建成功。
- `npm run eval`：四类套件 120/120，关键用例 20/20，Recall@Inject 与 Empty Precision 均为 100%，排除违规 0；平均动态预算 171、最大总预算 282，p95=1.0ms。
- 万条记忆、100 次查询：p50=5.37ms，p95=7.08ms，最大 8.11ms。基准使用本地合成数据，耗时会随机器负载变化。
- `git diff --check`：通过；Git 仅提示既有的 Windows 换行符转换。

验证边界：本轮使用内存库/临时数据库、模拟宿主和合成事件；未连接真实模型供应商，未执行 DSH Desktop 实机重载。仅完成本地修改与构建，未提交、推送或部署。
