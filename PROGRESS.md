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

