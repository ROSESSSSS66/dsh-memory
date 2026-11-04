# DSH Self-Evolving Memory · 实施随记 (NOTES.md)

## M0 探测记录与环境决策

### M0-T1 运行时探测结果
- **Node.js**: v24.18.0 (平台: win32 / x64)
- **node:sqlite**:
  - `DatabaseSync` 导入与内存数据库可用
  - FTS5 支持通过验证：`CREATE VIRTUAL TABLE test_fts USING fts5(x)` 及 MATCH 检索完全正常
  - 事务与回滚支持通过验证
  - 磁盘持久化文件写入与重新打开校验通过
  - **决策**：主存储直接使用内置 `node:sqlite` + FTS5，无需编译任何原生依赖，无需回退到 `sql.js`。
- **node:zlib**:
  - `typeof zlib.zstdDecompressSync` 确认为 `function`
  - 往返压缩/解压测试通过
  - 实测 DSH 会话日志多帧解析：采用 §A.4.1 算法准确识别并解压全部帧（测试 857KB 压缩日志，共 587 帧，准确解压出 3,142,880 字节与 1093 行事件）。
- **离线模型与预算限制**：
  - 观察到的 provider: `sub2api-deepseek` (包含 `deepseek-ai/deepseek-v4-flash-0731`)、`amd-deepseek` (包含 `DeepSeek-V4.1-Flash`)。
  - 请求必须严格遵循 dailyLLMCalls (40) 与 dailyLLMTokens (200k) 的原子预留与 ledger 记账。

### M0-T2 注入路径与协议假设
- 源码证据确认：`agent/pre-step` 监听器中通过展开 `decision` 并追加 `createUserMessage` 构造的新消息，返回 `{ ...decision, messages: [...decision.messages, message] }`。
- `source.kind` 约定为 `{ kind: 'plugin', plugin: 'dsh-memory', memoryRefs: [...] }`。
- 只有已提交的事件才作为有效注入并更新可见性投影与 injections 记账。

### M0-T3 架构与生命周期记录
- SystemPrompt section: 注册在 agent 作用域，使用 `interpolate: false` 与 `order: 3000`。保存 disposer，在更新、agent 释放及插件 dispose 时清理。
- 插件异常绝不抛给 DSH，所有操作 try/catch 脱敏日志放行。

## M2 在线召回与集成记录

### M2-T2 在线召回系统与融合打分
- **意图检测与分词** (`query.ts`):
  - 覆盖 temporal / causal / procedural / preference 意图正则，经受多组中英文正反例严格测试。
  - `contentTokens` 自动剔除检索提示词（如“今天”、“怎么”等）与停用词，作为绝对相关性第一硬门槛依据。
- **召回通道实现** (`channels.ts`):
  - `lexical`: memory_fts MATCH (前32 token OR拼接) + scope过滤 + active/frozen过滤。
  - `entity`: 先 JOIN memories 在 WHERE 中按 scope 与实体过滤，再 GROUP BY count(*) DESC LIMIT 30，避免跨工作区干扰项挤占目标工作区。
  - `typed`: 仅在 procedural 或 causal 意图下检索 procedural / failure / episodic。
  - `temporal`: 支持各种时间表达式解析；仅在 temporalBrowse 为真时放行 superseded 历史记录。
  - `preference`: 偏好意图下按 utility 降序检索。
- **融合与门槛** (`fuse.ts`):
  - 第一步先执行绝对相关性硬门槛，未达标直接剔除；改变 RRF 权重无法绕过硬门槛（“今天天气”遇到当天数据库事实准确返回空）。
  - 加权 RRF 归一化后打分：relevance 0.3 + confidence 0.2 + utility 0.2 + freshness 0.1 + consistency 0.1 + specificity 0.1。
  - 矛盾项 consistency 降为 0.3；尾部 relative rank 过滤丢弃低相关项。
- **Token 预算装箱** (`governor.ts`):
  - 去除 caller `alreadyInjected` 中的 `id@content_rev`，支持正文修订后再次注入。
  - 冲突槽位保留最新有效记录；相同 content hash 仅保留最高分一项。
  - 首选放入最高分项，其余按 VPT (Value Per Token) 降序装箱，无法容纳 content 时降级为 summary。
  - 严格确保实际完整渲染块 `budgetTokens <= budget`。
- **提示词渲染** (`render.ts`):
  - 产出严格遵循 §5.10 示例规范（逐字快照一致）。
  - 短码 `m_` 前 4 位发生碰撞时逐步动态延长，彻底杜绝歧义。
  - 渲染前经过 `redactSecrets` 隐私扫描与 XML 转义。
- **压测与性能基准** (`recall.test.ts`):
  - 10,000 条记忆数据库，100 次并发查询实测：p50 = 13.30ms, p95 = 21.49ms（远优于 < 50ms 要求）。

### M2-T3 DSH 宿主集成与工具命令
- **稳定层 Section** (`prompt-section.ts`):
  - 仅渲染 pinned=1 且 active/frozen 的记录，按 id 升序排序以命中模型前缀缓存。
  - 预算超额时按 utility 从低到高剔除，保证稳定层 `<= 600` tokens。
  - 显式声明 `interpolate: false`，避免记忆中的 `{{}}` 导致系统提示词装配异常。
  - 每次刷新比对渲染 hash，不变则不重建；子代理与父代理按各自工作区隔离。
- **Pre-Step 动态注入** (`pre-step.ts`):
  - 使用 `{ prepend: true }` 拦截 `agent/pre-step`，await next 后向 `decision.messages` 追加记忆。
  - 构造消息 `role: 'user'`，`source.kind = 'plugin'`，`plugin = 'dsh-memory'`，包含 `memoryRefs` 数组。
  - 在同一会话内连续问 5 个相关问题，通过 `injections` 表记录去重，确保同一记忆在同一 session 只注入 1 次。
  - 临时数据库异常时优雅降级为原样放行，完全不破坏 DSH 主对话。
- **模型工具** (`tools.ts`):
  - `memory_search`: 限制 800 tokens，记录 `layer='tool'`。
  - `memory_expand`: 展开正文与最多 3 条来源证据，限制 1500 tokens，支持 4 位短码。
  - `memory_feedback`: 校验 `contentRev` 准确性，即时更新 utility 与 injection 结果。
  - `memory_note`: 助手备忘强制进入 `status='candidate'`，单轮限制最多 3 次。
- **用户命令** (`commands.ts`):
  - `/memory stats`: 打印总数、状态分布、类型分布及近 7 天注入量与纠正率。
  - `/memory inspect <id>`: 展示详细字段与来源 session 溯源。
  - 支持 `list`, `forget`, `pin`, `unpin`, `freeze`, `unfreeze`, `approve`, `pending`, `export`, `import`。

### M2-T4 历史会话回填与 zstd 解析
- **zstd 帧边界扫描** (`scanZstdFrames`):
  - 遵循 §A.4.1，按帧头结构和 block header 中的 3 字节小端大小精确定位 `[start, end)` 帧区间，不扫描 magic 子串（payload 中含 `28 B5 2F FD` 字节不会导致错误切片）。
  - 支持多完整帧 + 撕裂尾帧，撕裂尾部通过 `ZSTD_e_flush` 尝试恢复可用前缀，丢弃无法解析的残片。
- **文件与行流式解析** (`readSessionFile`):
  - 严格校验 header `version === 4` 且包含 `cwd`，旧版本与无 cwd 文件跳过。
  - 自动丢弃最后一行未以 `\n` 结尾的不完整 JSONL 行。
- **回填管道与幂等保证** (`runBackfill`):
  - `--dry-run`: 统计 `rawEvents`, `filteredEvents`, `privacyRejected`, `writableEvents`，不写入数据库。
  - 正式运行: 写入 `raw_events` 且调用 `runRules` 抽取记忆，新增事件数与 dry-run 的可写数一致。
  - 幂等性: 再次执行时新增为 0，`failure_sigs` 保持不变，旧的 `valid_from` 不覆盖更新的活跃槽位。
  - 排除工作区与隐私: 命中 `excludeWorkspaces` 或含敏感凭证的事件不入库，全程纯本地执行无外部网络请求。


## M3: 离线学习与演化核心验证记录 (2026-11-04)

### 1. 离线 LLM 账本与安全闸门 (M3-T1)
- **Token 预留与日配额守门**:
  - 当日已结算 Token 与处于 `reserved`/`unknown` 状态的完整预留求和计入消费；
  - 实测验证已用 199,000 tokens 时，输入 500 + 输出上限 1500 (共 2000 tokens) 的预留请求原子失败，且 HTTP 请求数严格为 0；
  - 40 次调用上限严格生效，第 41 次请求原子拦截，零外部调用；
  - 未经授权的 endpoint (`offlineConsent = false` 或 endpoint 不在 `allowedOfflineEndpoints`) 绝对阻断，请求数保持为 0；
  - 敏感凭证与 PII 在 HTTP request body 与 SQLite 账本备注中均被遮罩为 `[REDACTED:SECRET]`，无原值残留；
  - `cleanJsonText` 仅接受裸 JSON 或包裹整体响应的单一代码围栏，任何前后夹杂的闲聊废话直接导致解析失败。

### 2. 离线任务调度器与互斥执行器 (M3-T2)
- **全局互斥与超时收敛**:
  - 内存与执行锁严格保证同一时刻仅有 1 个离线任务在跑，并发执行请求直接返回 `false`；
  - 单任务执行硬限制 120s；超时后立即触发 `AbortController.abort()`，并等待 runner handler 完全收敛后再释放互斥锁，杜绝失控任务并发写库；
  - 系统启动恢复逻辑将上次残留的 `running` 状态任务转为待核查的 `failed`，并同时将 ledger 的 `reserved` 恢复为 `unknown` 保守占用额度；
  - 因预算不足导致的 `skipped` 任务记录 `next_eligible_at` 为次日 `00:00:01`，当天不再重复调度，次日额度恢复后自动就绪；
  - 不可重试的解析错误与 schema 错误立即标记为 `failed`，绝不重复重试同一输入指纹。

### 3. 会话抽取器 (distill-v2, M3-T3)
- **连续有界批与水印推进**:
  - 连续有界选批严格受限于 6000 完整输入预算，超出预算的较晚事件完整保留留给后续批次，不丢弃早期事件；
  - 对伪造的 request-local seq、虚假 quote、引用未发送文本或遮罩标记的 item 严格丢弃，若全部无效整批失败；
  - 事务失败时不推进 `processed` 或 `meta.watermark`；
  - 模型返回合法的 `items: []` 时作为成功 no-op 处理，正常推进消费批次区间与水印。

### 4. 结果判定与失败反思 (reflect-v2 / outcome, M3-T4)
- **效用归因与单次反思**:
  - 下一轮用户纠正匹配正则后判定 `r = -1.0`，自动入队 `reflect:<session>:<turn>` 任务，重复判定同一 turn 保证幂等只入队一次；
  - 效用公式 `utility = utility + 0.1 * w * (target - utility)`：
    - `r = +1.0` 时，`used` 记忆由 0.5 变为 0.55，`unused` 记忆由 0.5 变为 0.51；
    - `r = -1.0` 时，`used` 记忆由 0.5 变为 0.45，`unused` 记忆由 0.5 变为 0.49；
  - 反思生成的 `failure` 候选记忆严格贴上 `status = 'candidate'`，来自工具证据的可信度应用来源信任上限 (0.5)。

### 5. 知识巩固与日常维护 (consolidate-v2 / maintenance, M3-T5)
- **技能提炼与数据维护**:
  - 必须由 3 个独立 session 的成功证据（`used=1 AND outcome>0.5`）支撑且共享实体与 Jaccard >= 0.35 的分量才允许触发 consolidate；单一 session 重复成功不凑数；
  - 生成 `procedural candidate` 时在 `memory_relations` 记录 `derived_from` 关系并固化源记录 `content_rev/hash` 快照，源记录保持原状不变；
  - 源记录在发送前或提交前一旦发生状态、正文或 hash 改变，立即丢弃整次响应并重新聚类；
  - 冷记忆超过 60 天且 utility < 0.35 时归档，自动跳过 `frozen`、`superseded` 与 `pinned=1`；
  - 超过 30 天未批准候选与过期修复提案自动转为 `rejected`；
  - 热备生成 `memory-YYYYMMDD-HHmmss.db`，严格轮换仅保留最近 7 份。


## M4: 评测体系与 MVP 回归门禁验证记录 (2026-11-04)

### 1. 评测集与指标实现 (M4-T1, M4-T2)
- **生成集规格**:
  - `generateDataset()` 生成确定性 PRNG 种子下的 120 条用例，覆盖 4 大 Suite（factual 30、temporal 30、procedural 30、implicit 30）；
  - 包含 20 条 critical 用例与 12 条空门槛（include 为空）测试用例；
  - 独立 `:memory:` 隔离沙箱，前置 setup 经真实受信任适配写入，确保评测环境零副作用与可复现性。
- **评测运行与门禁结果 (M4-T3)**:
  - 运行命令: `npm run eval`
  - 运行时间: 0.43s (120 个用例)
  - 核心指标表现:
    - `Recall @ Inject`: **97.2%** (MVP 门槛 >= 70%) [OK]
    - `Exclude Violations`: **0** (MVP 门槛 == 0) [OK]
    - `Empty Precision`: **100.0%** (MVP 门槛 >= 80%) [OK]
    - `Critical Passed`: **20/20 (100%)** [OK]
    - `Avg Dynamic Tokens`: **157** (MVP 门槛 <= 1600) [OK]
    - `Max Budget Tokens`: **282** (MVP 门槛 <= 3200) [OK]
    - `p95 Latency`: **0.7ms** (MVP 门槛 <= 50ms) [OK]
  - **MVP 判定**: 全部门禁项目 100% 达标通过，退出码 0。


## M5: 检索策略进化与实验室 (EvolveMem, 2026-11-04)

### 1. 策略版本化与配置约束 (M5-T1)
- 启动时自动注入与持久化 v1 默认策略 (`DEFAULT_STRATEGY`)，带内存只读缓存与原子替换；
- 每次 recall 与策略读取动态受限于 `cfg.hardBudgetTokens - cfg.stableBudgetTokens` 上限与当前 `cfg.maxLabItems` 整数约束，防止运行时配置收紧被旧策略绕过；
- `scoreWeights` 在变异和持久化前强制归一化且求和为 1.0。

### 2. 进化实验室与哨兵回滚 (M5-T2, M5-T3)
- **晋升条件检验**:
  - 变异候选必须满足：Recall 提升 >= 0.02、平均注入 Token <= 基线 1.10 倍、关键用例（Critical）身份保持通过、Exclude 违规不增加、空门槛精度 >= 0.8、所有预算约束通过；
  - 若候选导致基线已通过的 critical 用例失败，即使召回总数提高仍严禁晋升；
- **停滞探索与哨兵回滚**:
  - 连续 3 次进化无晋升时，变异缩放系数 $s$ 自动由 0.2 提升至 0.4 扩大探索；
  - 哨兵监控通过比较晋升后 50 轮与晋升前 50 轮纠正率：若新纠正率 > 旧纠正率 + 0.05，自动触发回滚至 parent 版本并把故障版本置为 `rejected`；
- **收获用例采集**:
  - `harvestSample` 成功将使用且肯定的用户交互样本落盘至 `eval_cases` 表，形成增量回归集。


## M6: 查询触发修复与提案审批 (RIME / repair-v2, 2026-11-04)

### 1. 触发与离线学习
- 在 active 记忆被 `memory_expand` 且该轮 outcome $r \le -0.6$ 时自动入队修复任务；
- 严格遵循 7 天冷却时间 (`cfg.repairCooldownDays`)，重启无法绕过；`frozen` 状态记忆绝不自动修复；
- 来源证据不足或无有效摘录时自动判定为 `skipped`，禁止模型无凭据猜测。

### 2. Appendix B-4 合同与提案生命周期
- **keep**: 成功 no-op，无提案生成；
- **revise**: 校验通过后生成 1 条候选记忆并建立 `derived_from` 关系，生成绑定原正文 `content_rev` 的 `repair_proposals`，原记忆保持 active；
- **split**: 校验通过后生成 2-3 条候选记忆并分别建立 `derived_from` 关系，生成 `repair_proposals`；
- **invalidate**: 生成 `repair_proposals`，原记忆保持 active；
- **审批安全门禁**:
  - 普通 `approveCandidate` 严格拒绝直接批准关联未决 `repair_proposals` 的候选记忆，杜绝绕过原子审批；
  - `/memory approve-repair` 必须校验提案未过期（30天）、原记忆处于 active 且未 frozen，且原记忆 `content_rev` 未发生变化；
  - 批准 revise/split 时在同一事务内 supersede 原记录并激活候选记录；
  - `/memory reject-repair` 拒绝提案并将关联候选记忆置为 `rejected`，原记忆保持原样不变。


## §8.4 & §10: MVP 验收清单全量验证与协议归档 (2026-11-04)

### 1. 规模扩展性与 Token 稳定性 (MVP-3)
- 在真实 SQLite 1,000 条与 10,000 条记忆库上运行基准查询：
  - `avgInjectTokens` (1k): 稳定装箱于预设预算区间；
  - `avgInjectTokens` (10k): 与 1k 规模对比差异严格 **< 10%**（实测差异趋近于 0%），证明 Token 输入不随记忆库规模增长；
  - 动态预算与硬上限：任何情况下动态注入块均受限于 `dynamicBudgetTokens`，总渲染块严格 `<= cfg.hardBudgetTokens (3200)`。

### 2. 在线安全与零外部请求 (MVP-5)
- 在关闭后台调度器的情况下连续执行 20 轮真实 `agent/pre-step` 动态瀑布流注入：
  - 离线 LLM 账本表 `llm_ledger` 增量严格为 0；
  - 离线 Token 结算与预留消费严格为 0；
  - 外部网络与 HTTP 调用数为 0，完全纯本地 SQLite 检索。

### 3. 数据备份、导出与原子恢复 (§10)
- **夜间热备与轮换**:
  - `backupDatabase` 生成 `memory-YYYYMMDD-HHmmss.db`，在原子重命名前强制执行 `PRAGMA integrity_check` 与结构校验；严格轮换仅保留最近 7 份；
- **数据库文件导出与导入**:
  - `/memory export <path>`: 目标路径已存在时硬性拒绝覆盖，经唯一临时文件 `VACUUM INTO` 并校验 `PRAGMA integrity_check` 与必需表后原子重命名；
  - `/memory import <path>`: 在只读连接全面检查 `integrity_check`、`meta.schema_version`、必需核心表与列约束；为现有库生成 `.bak` 备份；通过后在独立事务内恢复数据并即时重建 FTS 全文索引；
  - 损坏文件与非法 schema 导入被绝对阻断，原库完全不受影响。

### 4. 最终全量回归与门禁状态
- **单元与集成测试**: 37 个测试套件，**230 个测试 100% 全部通过** (`npm run check`)；
- **构建输出**: `npm run build` 生成标准 ESM bundle 与 `.d.ts` 类型声明；
- **评测基准**: `npm run eval` 跑通 120 条用例，Recall@Inject 97.2%、Exclude Violations 0、Empty Precision 100%、Critical Passed 20/20，全指标远超 MVP 门槛。
