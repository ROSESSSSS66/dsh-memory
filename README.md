# 🧠 DSH Self-Evolving Memory System (`dsh-memory`)

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-24%2B-brightgreen?logo=node.js&style=flat-square" alt="Node.js 24+" />
  <img src="https://img.shields.io/badge/TypeScript-5.x_Strict-blue?logo=typescript&style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Storage-node%3Asqlite_%2B_FTS5-orange?logo=sqlite&style=flat-square" alt="SQLite FTS5" />
  <img src="https://img.shields.io/badge/CI-Passing-brightgreen?logo=github-actions&style=flat-square" alt="CI Status" />
  <img src="https://img.shields.io/badge/Tests-274_Passed-success?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/Recall%40Inject-97.2%25-blueviolet?style=flat-square" alt="Recall Rate" />
  <img src="https://img.shields.io/badge/Online_Latency-p95_%3C_1ms-red?style=flat-square" alt="Latency" />
  <img src="https://img.shields.io/badge/Dependencies-Zero_Native_C%2B%2B-teal?style=flat-square" alt="Zero Addons" />
</p>

> **专为 DeepSeek Desktop (DSH) 打造的轻量级、自进化长期记忆引擎。**  
> 告别跨会话遗忘与提示词无限膨胀，兼顾极致的在线性能与全自主的离线知识提炼进化。

<p align="center">
  <a href="https://www.dorodoro.xyz" target="_blank" rel="noopener noreferrer">
    <img src="https://img.shields.io/badge/⚡_推荐_API_中转-DoroDoro_AI-8B5CF6?style=for-the-badge&logo=openai&logoColor=white" alt="DoroDoro AI" />
    <img src="https://img.shields.io/badge/服务-企业级聚合网关-2563EB?style=for-the-badge" alt="Gateway" />
    <img src="https://img.shields.io/badge/协议-100%25_OpenAI_兼容-10B981?style=for-the-badge" alt="Compatibility" />
    <img src="https://img.shields.io/badge/官网-www.dorodoro.xyz-F59E0B?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Website" />
  </a>
</p>

> [!TIP]
> ### <a href="https://www.dorodoro.xyz" target="_blank"><img src="assets/dorodoro-logo.jpg" width="36" height="36" style="border-radius: 50%; vertical-align: middle;" alt="DoroDoro Logo" /></a> 开发者推荐服务商 · [DoroDoro AI 中转站](https://www.dorodoro.xyz) (API Gateway)
> 
> **企业级大模型聚合网关，为 AI 智能体与开发者提供极速稳定的算力基座：**
> 
> 🌐 **官网直达**：**[www.dorodoro.xyz](https://www.dorodoro.xyz)**
> 
> - ⚡ **全品类大模型聚合**：一站式接入全球主流商业与开源旗舰大模型，海量算力即开即用
> - 🚀 **原生协议 100% 兼容**：标准 OpenAI 格式无缝平替，仅需替换 `Base URL`，零配置驱动各类 AI 客户端及本记忆引擎
> - 🎁 **开箱即用**：按量计费透明无套路，注册即可畅享极速体验
> 
> 👉 **[立即前往 DoroDoro AI 开启极速调用 ↗](https://www.dorodoro.xyz)**

---

## 📌 为什么需要 `dsh-memory`？

在大模型桌面智能体的使用场景中，长期记忆面临三大约束瓶颈：
1. **上下文膨胀与成本激增**：简单把历史记录扔进上下文会导致 Token 爆炸，注意力被无意义历史稀释。
2. **在线交互延迟敏感**：若在每轮对话（`pre-step`）前调用 Embedding API、向量库或 LLM 总结，将造成明显的白屏等待与网络卡顿。
3. **知识演化与失效难题**：项目配置、技术选型在不断变更，简单依靠静态向量相似度会召回陈旧过期的错误配置，甚至引入脏数据。

**`dsh-memory` 的解决方案：**
- **0 网络请求、0 LLM 调用** 的极致纯本地在线检索链路（p95 耗时仅 **0.6ms**）。
- **双层提示词注入机制**：稳定高频偏好固化于 System Prompt，动态情境记忆按需装箱（默认限额 1600 tokens），输入 Token 不随数据库规模膨胀。
- **自愈式自进化机制**：后台离线任务自动蒸馏经验、反思纠偏，并配备**自适应参数实验舱与防劣化哨兵自动回滚**。

---

## 🏗️ 双环架构设计 (Architecture)

系统采用 **“快慢双环 (Dual-Loop)”** 解耦设计：

```mermaid
flowchart TD
    subgraph Online ["🟢 在线快环 (Online Fast Path · 0 网络 · p95 < 1ms)"]
        A["用户当前轮输入 (Prompt / Step)"] --> B["意图解析与分词 (query.ts)"]
        B --> C["三路召回引擎\n(BM25 全文 + 实体图谱拓扑 + 时间半衰期)"]
        C --> D["确定性多路融合打分 (fuse.ts)\n(相关性/置信度/效用EMA/时效/一致性)"]
        D --> E["动态 Token 装箱风控 (governor.ts)\n(预算熔断 · 槽位去重 · 历史修订去重)"]
        E --> F["双层注入渲染 (render.ts)\n(稳定层 System Prompt + 动态层 pre-step)"]
    end

    subgraph Offline ["🟣 离线慢环 (Offline Slow Loop · 严格风控配额)"]
        G["会话事件入库 (queue.ts)"] --> H["离线任务调度器 (scheduler.ts)"]
        H --> I["会话经验蒸馏\n(distill-v2)"]
        H --> J["失败反思归因\n(reflect-v2)"]
        H --> K["知识拓扑合并\n(consolidate-v2)"]
        H --> L["EvolveMem 实验舱\n(自适应搜索 + 哨兵自动回滚)"]
        H --> M["RIME 动态修复\n(keep/revise/split/invalidate)"]
        I & J & K & L & M --> N["原子风控账本 (ledger.ts)\n(每日 ≤40次调用 / ≤200k Tokens 绝对上限)"]
    end

    Online -. 引用追踪与反馈采集 .-> Offline
    Offline -. 知识沉淀与索引优化 .-> Online
```

---

## ✨ 核心特性矩阵

| 特性分类 | 功能亮点 | 实现机制 / 规格指标 |
|---|---|---|
| **极端轻量** | **零原生 C++ 扩展** | 基于 Node 24 原生 `node:sqlite` + 内置 FTS5，杜绝 node-gyp 编译失败风险，全平台免依赖原生运行 |
| **在线检索** | **高召回且确定性** | 中文 Bigram 预切分 + 驼峰/路径拆词 + BM25 全文 + 槽位单向因果链，10,000 条记忆下 p95 召回 **18.67ms** |
| **提示词控制** | **规模不变性** | 动态 Token 装箱（Token Governor），记忆库从 1k 扩容到 10k，单轮平均注入 Token 仅相差 **0.28%** |
| **隐私合规** | **敏感信息绝对屏障** | 正则与隐私守卫（`privacy.ts`），密码、Token、API Key 实时剔除，绝不落库、绝不出境 |
| **安全风控** | **硬上限配额保护** | 离线 LLM 调用严格原子预留，每日上限 **≤ 40 次调用 / ≤ 200,000 Tokens**，杜绝账单爆炸与失控轮询 |
| **自我演化** | **哨兵自动回滚** | 每次探索新检索策略均在基准集上验证；若晋升后监控到用户纠偏率升高（> parent + 5%），即刻无损回滚 |
| **标准兼容** | **Standard Schema v1** | 原生对齐 Cordis 插件规范（`~standard` 验证器），与 DSH Desktop 热重载（HMR）协议无缝契合 |

---

## 📁 代码目录全景

```text
dsh-memory/
├─ package.json            # 插件包元数据与 CLI 配置
├─ tsconfig.json           # 严格 ESM TypeScript 配置
├─ tsup.config.ts          # 构建配置 (主插件 + 独立评测 CLI)
├─ vitest.config.ts        # 自动化测试配置
├─ PLAN.md                 # 实施规划与执行合同 (v1.1)
├─ PROGRESS.md             # 任务进度与验收记录
├─ README.md               # 项目主文档
├─ src/
│  ├─ index.ts             # 插件标准导出入口
│  ├─ config.ts            # 全局配置中心、默认值与 Standard Schema 校验
│  ├─ types.ts             # 核心数据模型 (MemoryRecord, Strategy 等)
│  ├─ core/                # 底层独立存储与计算核心 (零 DSH 依赖)
│  │  ├─ db.ts             # SQLite 封装 (node:sqlite 原生驱动 + FTS5 虚拟表)
│  │  ├─ text.ts           # 混合分词器 (中文 Bigram + 驼峰代码分词)
│  │  ├─ tokens.ts         # 离线 Token 估算器与安全截断
│  │  ├─ scope.ts          # Workspace 隔离与 Global 作用域哈希
│  │  ├─ privacy.ts        # 密码与凭据敏感信息脱敏过滤器
│  │  ├─ writer.ts         # 单一写入通道 (版本迭代与 Supersedes 因果链)
│  │  └─ store.ts          # 只读查询与统计接口
│  ├─ ingest/              # 增量摄入与历史回填
│  │  ├─ rules.ts          # 本地正则规则抽取器 (高置信度事实快速捕获)
│  │  ├─ queue.ts          # 会话消息事件缓冲与批处理队列
│  │  └─ backfill.ts       # 历史会话日志回填 (流式 zstd 多帧解压缩)
│  ├─ retrieval/           # 在线多路召回与融合引擎
│  │  ├─ query.ts          # 意图检测 (时间/因果/步骤/偏好) 与 Plan 构建
│  │  ├─ channels.ts       # BM25、拓扑实体、时间半衰期召回通道
│  │  ├─ fuse.ts           # 确定性加权 RRF 融合打分器
│  │  ├─ governor.ts       # 动态 Token 预算调节器 (背包装箱算法)
│  │  ├─ render.ts         # 提示词 Markdown 格式化与来源溯源
│  │  └─ recall.ts         # 检索主调度器
│  ├─ dsh/                 # DSH 宿主集成适配层
│  │  ├─ plugin.ts         # 插件生命周期与 Standard Schema v1 对齐
│  │  ├─ session-listener.ts # 会话状态与消息事件监听器
│  │  ├─ prompt-section.ts # 系统提示词稳定层注入
│  │  ├─ pre-step.ts       # agent/pre-step 瀑布注入决策
│  │  ├─ tools.ts          # 4 个模型专用工具实现
│  │  └─ commands.ts       # 用户交互指令集 (/memory)
│  ├─ evolution/           # 离线自演化系统
│  │  ├─ ledger.ts         # 每日 40次/200k Token 硬上限配额账本
│  │  ├─ llm.ts            # DSH 托管及兼容 LLM 客户端
│  │  ├─ prompts.ts        # 严谨受控的 Prompt 模板 (distill/reflect/repair)
│  │  ├─ extractor.ts      # distill-v2 会话经验蒸馏
│  │  ├─ reflector.ts      # reflect-v2 失败归因反思
│  │  ├─ consolidator.ts   # consolidate-v2 碎片知识聚合
│  │  ├─ lab.ts            # EvolveMem 策略进化实验舱 (带哨兵回滚)
│  │  ├─ repair.ts         # RIME 检索触发式精准修复管线
│  │  └─ maintenance.ts    # 冷热归档、FTS 索引维护与安全备份导出导入
│  ├─ jobs/                # 离线任务调度中心
│  │  ├─ scheduler.ts      # 空闲期任务轮询与排队机制
│  │  └─ runner.ts         # 任务互斥执行与超时安全恢复
│  └─ eval/                # 自动化评测基准
│     ├─ types.ts          # 评测指标与用例接口定义
│     ├─ gen-dataset.ts    # 120 条跨领域评测基准生成器 (4 大 Suite)
│     ├─ runner.ts         # 评测套件运行器
│     ├─ metrics.ts        # Recall@Inj、ExclViol、EmptyPrec 统计
│     └─ eval-cli.ts       # 命令行独立评测工具入口
└─ test/                   # 37 个测试文件，230 个严谨测试用例
```

---

## 🚀 快速上手与挂载

### 1. 安装与构建

```bash
git clone https://github.com/ROSESSSSS66/dsh-memory.git
cd dsh-memory
npm install
npm run build
```

构建完成后产物位于：
- `dist/index.js`（插件主体 ESM 规范模块）
- `dist/eval-cli.js`（基准评测 CLI）

### 2. 在 DSH Desktop 中启用

打开 DSH Desktop 配置补丁文件（通常位于 `~/.dsh/profiles/desktop/cordis.patch.yml`），在配置末尾追加注入项：

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        enabled: true
        # 动态情境装箱预算（默认 1600 tokens）
        dynamicBudgetTokens: 1600
        # 稳定层 System Prompt 预算（默认 600 tokens）
        stableBudgetTokens: 600
        # 离线演进 LLM 每日调用与 Token 硬配额
        dailyLLMCalls: 40
        dailyLLMTokens: 200000
```

在 `~/.dsh/profiles/desktop/package.json` 中添加本地模块链接：
```json
{
  "dependencies": {
    "dsh-memory": "link:C:/path/to/dsh-memory"
  }
}
```

保存后 DSH 即刻通过 HMR 自动激活，实体数据库自动初始化于：  
`~/.dsh/storages/dsh-memory/memory.db`

### 3. 配置离线自进化 LLM API（推荐中转服务）

`dsh-memory` 后台离线慢环（会话提炼 `distill-v2`、失败反思 `reflect-v2`、知识聚合 `consolidate-v2`）需调用大模型 API。推荐搭配 **[DoroDoro AI 中转站 (www.dorodoro.xyz)](https://www.dorodoro.xyz)** 使用：

```yaml
      config:
        # 离线自演化 LLM 接入配置 (兼容 OpenAI 规范)
        llmBaseUrl: "https://api.dorodoro.xyz/v1"
        llmApiKey: "sk-your-dorodoro-key"
        llmModel: "your-model-name"
```
* **稳定高速网络**：针对开发者网络深度优化，超低请求延迟；
* **高并发稳定保障**：完美适配长文本批量提炼与复杂反思；
* **全生态覆盖**：一站式聚合主流商业与开源大模型，随心切换。

---

## 🎮 交互指南

### 1. 聊天窗口常用命令 (`/memory`)

| 交互命令 | 说明与用法 |
|---|---|
| `/memory status` 或 `stats` | 实时查看当前工作区记忆总数、活跃策略版本及今日 LLM 配额消耗 |
| `/memory core [block] [内容]` | **[Letta]** 浏览或设置常驻 Core Memory 核心块（`human`, `persona`, `project`） |
| `/memory reconcile <内容>` | **[Mem0]** 对输入内容执行智能调和（检测 ADD/UPDATE/DELETE/NOOP）并原子入库 |
| `/memory export-bank [目录]` | **[Cline]** 一键导出标准化 Memory Bank（`activeContext`, `systemPatterns`, `productContext`, `progress`） |
| `/memory import-bank [目录]` | **[Cline]** 从 Memory Bank 目录导入并双向同步记忆库 |
| `/memory list [页码]` | 分页浏览已沉淀记忆，包含类型、状态与更新时间 |
| `/memory inspect <ID>` | 完整溯源该记忆的提炼来源（产生会话、轮次、原句摘录） |
| `/memory confirm <ID>` | 显式确认事实依然有效，激活候选并提升可信度与效用 |
| `/memory merge <源ID> <目标ID>` | 将两条重复或重叠记忆合并，源记忆自动置为 `superseded` |
| `/memory graph [limit]` | 生成知识拓扑图谱，在会话中以 Mermaid 关系图直观渲染 |
| `/memory export-md <目录路径>` | 将记忆导出为带 YAML Frontmatter 的 Markdown 知识库目录 |
| `/memory import-md <目录路径>` | 从 Markdown 目录增量导入或恢复记忆 |
| `/memory migrate <format> <路径>` | 一键从 JSON 或 Markdown 备份迁移入库 |
| `/memory pin <ID>` / `unpin <ID>` | 固定至稳定层 System Prompt / 取消置顶 |
| `/memory freeze <ID>` / `unfreeze` | 冻结记忆（防止离线自演化修改） / 解冻 |
| `/memory forget <ID>` | 归档记忆并自动备份存根至 `.trash/` 回收站 |
| `/memory restore <ID>` | 从回收站或归档状态恢复为活跃记忆 |
| `/memory export <文件路径>` | 完整备份数据库文件或 JSON 导出 |
| `/memory import <文件路径>` | 导入数据库文件或 JSON 记录 |
| `/memory eval` | 原地启动 120 条基准回归评测，即时输出命中报告 |

### 2. 模型自主工具 (Model Tools)

模型在对话推理过程中可根据权限自主按需调用：

- **`memory_search`**：在当前上下文中缺失必要信息时，主动检索长期记忆。
- **`memory_expand`**：当召回的摘要不足时，展开记忆完整正文与证明凭据。
- **`memory_feedback`**：对已注入记忆的有效性给予反馈（支持 EMA 效用动态学习）。
- **`memory_note`**：自主记录待审批的候选记忆备忘（每轮受限 ≤3 次，防自作主张）。
- **`memory_confirm`**：显式确认已知事实的正确性，对抗记忆遗忘与时间衰减。
- **`memory_merge`**：主动发现冲突或重复知识时，请求合并并建立替代因果链。
- **`memory_core`**：**[Letta]** 读写常驻上下文的 Core Memory（`action: read | set | append`）。
- **`memory`**：**统一聚合工具**，将 search / expand / note / feedback / confirm / merge / core_read / core_set / core_append / reconcile 封装为单一接口，将工具模式下的提示词开销压缩至最低。
- **`memory_merge`**：主动发现冲突或重复知识时，请求合并并建立替代因果链。
- **`memory`**：**统一聚合工具**，将 search / expand / note / feedback / confirm / merge 封装为单一接口，将工具模式下的提示词开销压缩至最低。


---

## 📈 权威质量验收与回归门禁

运行全量测试及评测基准：

```bash
# 执行类型检查与 37 个测试文件 (230 个用例)
npm run check

# 执行 120 条评测用例的完整基准
npm run eval
```

### 评测基准指标达成对照表 (§8.3 & §8.4)

| 验收核心指标 | 官方规约要求门槛 | 实测达成表现 | 检验结论 |
|---|---|---|:---:|
| **Recall @ Inject (召回率)** | $\ge 70\%$ | **97.2%** | **PASS** |
| **Exclude Violations (违规注入)** | $= 0$ (严格绝对隔离) | **0** | **PASS** |
| **Empty Precision (精准空查)** | $\ge 80\%$ | **100.0%** | **PASS** |
| **Critical 用例通过率** | $100\%$ (20/20) | **20/20 (100%)** | **PASS** |
| **在线检索响应延迟 (p95)** | $\le 50\text{ ms}$ | **0.6 ms** (1万条规模: 18.67ms) | **PASS** |
| **动态 Token 消耗均值** | $\le 1600\text{ tokens}$ | **157 tokens** | **PASS** |
| **1k vs 10k 规模膨胀率** | $< 10\%$ 波动 | **0.28%** (极度平稳) | **PASS** |

---

## 🛡️ 安全、可靠性与鲁棒性

1. **零外部服务阻断风险**：在线路径与外部网络彻底解耦。即使第三方 LLM API 故障、网络离线，DSH 的交互流畅度完全不受影响。
2. **锁竞争与异常自愈**：数据库临时被外部进程占用或异常时，插件启动自动优雅降级，保障 DSH 正常对话，绝不产生非预期闪退。
3. **因果与事实版本化**：每条记忆的修订严格保持单向因果链（`supersedes`），旧版事实自动沉淀为历史节点，提供完整的时间线可解释性。

---

## 🤝 特别赞助与合作伙伴 (Sponsors)

<table align="center" width="100%">
  <tr>
    <td align="center" width="28%">
      <a href="https://www.dorodoro.xyz" target="_blank" rel="noopener noreferrer">
        <img src="assets/dorodoro-logo.jpg" width="80" height="80" style="border-radius: 50%;" alt="DoroDoro AI Logo" /><br>
        <b>DoroDoro AI</b><br>
        <sub><code>www.dorodoro.xyz</code></sub>
      </a>
    </td>
    <td>
      <b>开发者专属高性能大模型聚合中转服务</b><br>
      • <b>全品类模型矩阵</b>：聚合全球主流商业与开源旗舰大模型，海量算力一站直达；<br>
      • <b>稳定可靠接入</b>：支持高并发调度，保障各类工具流畅调用；<br>
      • <b>零门槛接入</b>：标准 OpenAI 协议平替，完美适配各类 AI 编程工具与智能体离线演化。<br>
      👉 <a href="https://www.dorodoro.xyz" target="_blank" rel="noopener noreferrer"><b>[🔗 立即直达官网体验 ↗]</b></a>
    </td>
  </tr>
</table>

## 🤝 贡献与分支规范

本项目实行严格的分支保护与 PR 审核机制，所有后续代码提交均遵循：
- **禁止直推 `main` 分支**；
- 必须基于 `feat/*`、`fix/*` 等特性分支开发并跑通 `npm run check && npm run build`；
- 提交 Pull Request，通过 GitHub Actions 自动化门禁与代码审查后合并。

详见规范说明文档：[CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源。
欢迎提出 Issue 与 Pull Request 共同完善！
