# DSH Self-Evolving Memory System (`dsh-memory`)

> 基于原生 Node.js (`node:sqlite` + FTS5) 构建的 DeepSeek Desktop (DSH) 自进化长期记忆系统插件。

---

## 🌟 系统核心亮点

- **零延迟在线通路**：在线阶段（`agent/pre-step` 瀑布注入）实现 0 网络请求、0 LLM 调用，单次检索决策全量基准 p95 < 20ms（纯本地 BM25 + 图拓扑 + 时间衰减确定性打分）。
- **双层提示词注入架构**：
  - **稳定层 (System Prompt)**：固定注入 pinned、高质量 preferences 与高置信度事实（预算 600 tokens），避免上下文抖动。
  - **动态层 (Dynamic Memory)**：按 turn 上下文精确匹配召回，严格由 Token Governor 控制动态预算（默认 1600 tokens），对已注入历史自动做去重。
- **严格隐私与预算风控**：
  - **本地隐私过滤**：密码、Token、API Key、私人凭据绝不落库。
  - **离线 LLM 硬上限**：离线后台任务严格执行每日上限（默认 ≤40 次调用 / ≤200k tokens），原子预留额度，超额即刻熔断。
  - **零信任来源追踪**：显式追踪 `origin_kinds`，所有外部工具/网络内容默认未经用户审批不得生效，防止跨轮洗白。
- **全生命周期自进化 (M0–M6)**：
  - **会话蒸馏 (`distill-v2`)**：后台流式增量提取会话事实、偏好与操作规程。
  - **失败反思 (`reflect-v2`)**：监控用户纠偏与负反馈，自动沉淀避坑规则。
  - **知识聚合 (`consolidate-v2`)**：聚类相近碎片记忆，合并生成高阶结构。
  - **策略实验舱 (`EvolveMem`)**：基于离线评测集打分探索检索权重超参数，配备**哨兵实时监控，纠错率恶化即刻自动回滚**。
  - **查询触发修复 (`RIME`)**：针对检索偏差触发 `keep` / `revise` / `split` / `invalidate` 精准治理。

---

## 📁 项目架构

```text
dsh-memory/
├─ package.json            # 包含 dsh 插件元数据与 script 指令
├─ tsconfig.json           # TypeScript 5.x ESM 严格配置
├─ tsup.config.ts          # 打包配置：产出插件库 dist/index.js 与 CLI dist/eval-cli.js
├─ vitest.config.ts        # Vitest 单元与集成测试配置
├─ PLAN.md                 # 实施规划执行规范与约束合同 (v1.1)
├─ PROGRESS.md             # 里程碑演进与验收跟踪日志
├─ src/
│  ├─ index.ts             # 插件统一公开入口
│  ├─ config.ts            # 配置项、默认值与 Standard Schema 校验器
│  ├─ types.ts             # 记忆模型、状态机与底层数据结构类型定义
│  ├─ core/                # 存储与纯净计算核心 (无 DSH 耦合)
│  │  ├─ db.ts             # SQLite 封装 (node:sqlite 原生驱动 + FTS5 全文索引)
│  │  ├─ text.ts           # 混合分词器 (中文 Bigram + 驼峰/下划线分词)
│  │  ├─ tokens.ts         # 离线精确 Token 估算器与预算裁剪
│  │  ├─ scope.ts          # Workspace 与 Global 隔离计算
│  │  ├─ privacy.ts        # 敏感信息过滤与正则脱敏
│  │  ├─ writer.ts         # 单一写入通道 (Supersedes 链与版本管理)
│  │  └─ store.ts          # 只读查询与统计接口
│  ├─ ingest/              # 增量摄入与历史回填
│  │  ├─ rules.ts          # 本地正则规则抽取器 (高置信度快速入库)
│  │  ├─ queue.ts          # 会话事件防抖入库缓冲队列
│  │  └─ backfill.ts       # 历史会话回填 (流式 zstd 多帧解包)
│  ├─ retrieval/           # 在线多路召回与融合排序
│  │  ├─ query.ts          # 查询意图识别与 Plan 构建
│  │  ├─ channels.ts       # BM25、关系图谱、时间衰减召回通道
│  │  ├─ fuse.ts           # 确定性加权多路归一化打分器
│  │  ├─ governor.ts       # 动态 Token 预算调节与熔断器
│  │  ├─ render.ts         # 记忆 Markdown 渲染器与出处溯源格式化
│  │  └─ recall.ts         # 在线检索总调度
│  ├─ dsh/                 # DSH 宿主适配器 (唯一允许依赖 Cordis / @deepseek-ai)
│  │  ├─ plugin.ts         # 插件生命周期与 Standard Schema v1 对齐
│  │  ├─ session-listener.ts # 会话状态与消息事件钩子
│  │  ├─ prompt-section.ts # 系统提示词动态注入
│  │  ├─ pre-step.ts       # agent/pre-step 瀑布注入决策
│  │  ├─ tools.ts          # 4 个模型可见工具实现
│  │  └─ commands.ts       # 用户交互斜杠命令 (/memory)
│  ├─ evolution/           # 离线演进、LLM 账本与任务
│  │  ├─ ledger.ts         # 每日 40次 / 200k Token 硬限额度账本
│  │  ├─ llm.ts            # DSH 托管或离线 OpenAI 兼容 LLM 客户端
│  │  ├─ prompts.ts        # distill-v2 / reflect-v2 / repair-v2 结构化 Prompt
│  │  ├─ extractor.ts      # 会话蒸馏
│  │  ├─ reflector.ts      # 失败反思
│  │  ├─ consolidator.ts   # 相似记忆聚合
│  │  ├─ lab.ts            # EvolveMem 策略实验舱与哨兵自动回滚
│  │  ├─ repair.ts         # RIME 查询触发修复链路
│  │  └─ maintenance.ts    # 冷热归档、FTS 索引修复与数据库导出导入
│  ├─ jobs/                # 离线互斥任务调度器
│  │  ├─ scheduler.ts      # Cron/空闲调度与任务排队
│  │  └─ runner.ts         # 任务执行器与超时超时控制
│  └─ eval/                # 自动化评测基准
│     ├─ types.ts          # 评测指标与用例接口
│     ├─ gen-dataset.ts    # 120 条跨场景自动化评测用例集生成器
│     ├─ runner.ts         # 评测执行套件与报告生成
│     ├─ metrics.ts        # Recall@Inj、ExclViol、EmptyPrec 指标计算
│     └─ eval-cli.ts       # 独立 CLI 命令行评测工具
└─ test/                   # 37 个全模块单元与集成测试文件
```

---

## 🚀 安装与挂载

### 1. 本地编译构建

```bash
npm install
npm run build
```

构建成功后将生成：
- `dist/index.js`：插件标准 ESM 入口。
- `dist/eval-cli.js`：命令行独立基准评测工具。

### 2. 挂载到 DSH Desktop 配置文件

在 DSH Desktop 配置文件目录（例如 `~/.dsh/profiles/desktop/cordis.patch.yml`）追加：

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        enabled: true
        dynamicBudgetTokens: 1600
        stableBudgetTokens: 600
        dailyLLMCalls: 40
        dailyLLMTokens: 200000
```

同时在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 添加本地引用或符号链接：
```json
{
  "dependencies": {
    "dsh-memory": "link:C:/Users/<Username>/Desktop/dsh-memory-plan"
  }
}
```

DSH Desktop 重载后，日志 `~/.dsh/logs/desktop-next.log` 将提示：
```text
[info] [dsh-memory] Plugin initialized with database at: ~/.dsh/storages/dsh-memory/memory.db
```

---

## 💬 用户交互命令 (`/memory`)

在 DSH 客户端聊天窗口中输入：

| 指令 | 作用描述 |
|---|---|
| `/memory status` 或 `/memory stats` | 查看当前工作区记忆统计、策略版本与离线 LLM 额度使用情况 |
| `/memory list [页码]` | 分页浏览当前工作区记忆列表 |
| `/memory search <关键词>` | 测试多路召回引擎，返回检索打分与明细 |
| `/memory inspect <ID>` | 完整溯源查看指定记忆的原始会话、轮次与对话摘录 |
| `/memory pin <ID>` | 固定关键记忆，使其永久保留在稳定层 System Prompt 中 |
| `/memory unpin <ID>` | 取消固定置顶 |
| `/memory forget <ID>` | 物理删除指定的记忆及其全文索引关联 |
| `/memory add <文本>` | 手动快捷录入一条事实记忆 |
| `/memory export <导出路径>` | 将当前记忆库完整安全备份为指定文件 |
| `/memory import <导入路径>` | 从备份文件恢复或迁移记忆库 |
| `/memory eval` | 在会话中直接触发基准评测套件，生成命中召回率报告 |
| `/memory help` | 打印可用指令说明 |

---

## 🛠 模型可用工具

当启用了 `tools` 注入时，DSH 模型在推理阶段可调用以下四个工具（受权限与信任沙箱约束）：

1. **`memory_search`**：在长期记忆库中检索历史事实、配置与规程。
2. **`memory_expand`**：按记忆 ID 展开长正文详情与原始出处证据。
3. **`memory_feedback`**：向记忆系统反馈某条引用的实际帮助效果（`helpful: true/false`），用于动态效用 EMA 更新。
4. **`memory_note`**：模型自主记录待审批的候选记忆备忘（每轮最多 3 次，需经过用户确认才能晋升）。

---

## 📊 质量基准与回归验证

### 1. 运行回归测试套件

```bash
# 执行类型检查与全部 37 个测试文件 (230 个测试)
npm run check
```

### 2. 执行评测基准 CLI

```bash
# 全量 120 个用例评测
npm run eval

# 仅执行指定 Suite
npm run eval -- --suite factual
```

**MVP 门禁基线指标达成情况**：

| 指标要求 | MVP 门槛 | 实际测试达成值 | 状态 |
|---|---|---|:---:|
| **Recall @ Inject** | ≥ 70% | **97.2%** | **PASS** |
| **Exclude Violations** | == 0 | **0** | **PASS** |
| **Empty Precision** | ≥ 80% | **100.0%** | **PASS** |
| **Critical 用例通过率** | 100% (20/20) | **20/20 (100%)** | **PASS** |
| **Dynamic Tokens 均值** | ≤ 1600 tokens | **157 tokens** | **PASS** |
| **检索 p95 延迟** | ≤ 50ms | **0.6ms** (1 万条规模下 18.67ms) | **PASS** |
| **1k vs 10k 规模膨胀率**| < 10% | **0.28%** | **PASS** |

---

## 🔒 安全与合规说明

1. **零原生依赖破坏**：完全依托 Node.js 24 原生支持，杜绝 `better-sqlite3`、`node-gyp` 等 C++ 编译风险，兼容 Windows / macOS / Linux。
2. **离线隔离防护**：在线前置步骤永远不向外部发起网络请求或同步耗时计算，确保无论网络环境或第三方服务如何波动，DSH 的交互流畅性绝不受影响。
3. **自愈与容错机制**：数据库出现异常或锁死时自动优雅降级，不阻断主链路对话。
