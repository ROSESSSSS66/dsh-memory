# 附录 A · DSH API 速查（实测版）

> 核实时间：2026-10-03。核实方式：直接读取本机 DSH Desktop 安装目录下各 `@deepseek-ai/*` 包的 `package.json`、`README.zh.md` 与编译后的 `lib/*.js`。
> **凡是本附录标注 ✅ 的，都是从安装包源码里读出来的事实，可以直接照抄。**
> 标注 ⚠️ 的必须由 M0 探测任务实测，**不要凭猜测写代码**。

---

## A.0 运行环境（✅ 已实测）

| 项 | 值 |
|---|---|
| 安装根目录 | `E:\DSH\DSH NEXT\`（**不是** `E:\DSH\DSH Desktop\`，旧路径已失效） |
| 应用代码 | `E:\DSH\DSH NEXT\resources\app\` |
| 包目录 | `E:\DSH\DSH NEXT\resources\app\node_modules\@deepseek-ai\`（共 291 个包） |
| 应用版本 | `dsh-desktop-next@2.0.17-next` |
| DSH 核心版本 | `@deepseek-ai/dsh@0.2.0-rc.2` |
| Cordis 版本 | `@deepseek-ai/cordis@4.0.4` |
| 要求的 Node | `engines: "^22.19.0 \|\| >=24.0.0"` |
| 本机 Node | v24.18.0（所以 `node:sqlite` 和 `zlib.zstdDecompressSync` 都存在） |
| DSH 主目录 | `C:\Users\Windows11\.dsh\` |
| 会话日志根 | `C:\Users\Windows11\.dsh\sessions\` |
| 其他存储 | `C:\Users\Windows11\.dsh\storages\`（现有 `session_projcache/`、`workspace.json`） |
| Profile 目录 | `C:\Users\Windows11\.dsh\profiles\desktop\` |

**重要：** 所有会话事件里用的时间戳是**毫秒整数**（例：`1790851937149`）。

---

## A.1 服务接口面

### A.1.1 `ctx.systemPrompt`（✅）——包 `@deepseek-ai/dsh-system-prompt`

用途：把稳定记忆写进系统提示词。

```ts
ctx.systemPrompt.section({
  name: 'memory-stable',       // 全局唯一；同名作用域注册会遮蔽全局项
  order: 3000,                 // 数值越小越靠前；同值按名称的代码单元顺序
  text: '...',                 // 也可以是 ({ agent }) => string
  interpolate: false,          // 本项目必须显式设置；原样保留文本（含 {{ }}）
})
```

- **`interpolate` 默认是 `true`**：文本里的 `{{name}}` 会做变量插值，**未知引用会导致组装抛异常**。我们渲染的记忆块里可能出现任意用户内容，所以**必须显式写 `interpolate: false`**。
- 顺序参考值：第一方固定开场白是 `-1000`，persona 前缀 `0`，第一方指导居中，运行时上下文 `10000`、`10100`，persona 后缀 `10200`。**记忆段建议用 `3000`**（在第一方指导之后、运行时上下文之前）。
- 变量注册：`ctx.systemPrompt.variable('名字', ({ agent }) => 值)`。循环内建的变量有 `model` 和 `cwd`。
- 作用域：`agent.ctx.systemPrompt.section(...)` 注册在该 agent 的作用域，子作用域可继承；子 agent 必须注册同名的自身段覆盖继承项，并按自己的 workspace/session 重新渲染。agent 释放时其 effect 自动撤销；插件也须保存 disposer，在自身停用时撤销仍存活 agent 上的段。
- 变更通知事件名：`system-prompt/change`（**不做作用域筛选**，全局变更会影响每个作用域）。
- 组装结果的 KV 缓存结论（原文）：**"只要身份、persona、变量、段文本与顺序的渲染完全相同，前缀就保持稳定"**。→ 印证方案 §5.10 的"稳定层按 id 排序、hash 不变就不更新"是对的。
- ✅ **更新与注销已核实：** `section()` 返回 Cordis effect 的 disposer，不是可修改 text 的句柄；同一作用域同名注册会抛异常（`dsh-system-prompt/lib/index.js:190,234-242`）。渲染 hash 变化后先调用旧 disposer，再重新注册；保存各 agent 的 disposer，并在该 agent 释放及本插件 dispose 时清理。M0-T3 仍需覆盖真实加载/停用/热重载行为。

### A.1.2 `ctx.tools`（✅）——包 `@deepseek-ai/dsh-tools`

```ts
import { defineTool } from '@deepseek-ai/dsh-tools'

ctx.tools.register(defineTool({
  name: 'memory_search',
  description: 'Search long-term memory.',
  parameters: {
    query: { type: 'string', required: true, description: '...' },
    limit: { type: 'number' },
    types: { type: 'array', items: { type: 'string' } },
  },
  output: {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  },
  async execute(args, exec) {
    // args: { query: string; limit?: number; types?: string[] }
    // exec.signal 是 AbortSignal
    return '...'
  },
}))
```

- **参数用的是统一 schema DSL**，不是原始 JSON Schema：支持 `string` / `number` / `integer` / `boolean` / `null` / `array` / `object` / 仅供作者使用的 `json` / 恰好匹配一个分支的 `oneOf`。必填用 `required: true`。**不要写 `{"type":"object","properties":{...}}` 那种原始 JSON Schema。**
- `defineTool` 校验：`timeoutMs` 如果给了，必须是正有限数。
- `output.render` 把返回值转成模型可见的文本块。
- 注册即自动进入系统提示词的工具 schema 集合，不需要额外接线。
- 其他接口：`ctx.tools.get(name, scope)`、`ctx.tools.schemas(scope)`、`ctx.tools.restrict(filter)`（对单个 agent 做允许/拒绝掩码）、`ctx.tools.guard(guard)`（单调同步守卫）。
- 瀑布事件（监听器**必须调用 `next()`**）：`tools/pre-execute`（允许/拒绝/询问）、`tools/execute`（包装超时或重试）、`tools/post-execute`（可替换结果、可阻止、可追加有序上下文）。观察事件：`tools/result`（冻结的最终结果）。
- 配置项 `mode`：`native`（每个可见 schema）| `ptc`（只有 `run_code` 加一份生成 SDK）| `both`。**如果用户把它配成 `ptc`，我们注册的 4 个工具在模型侧可能看不见** —— 我们的工具数量少（4 个），建议在插件 README 里提醒用户保持 `native`。

### A.1.3 `ctx.commands`（✅）——包 `@deepseek-ai/dsh-commands`

```ts
ctx.commands.register({
  name: 'memory',                    // 必须小写，可含字母数字 _ -
  description: '记忆系统管理',
  input: { hint: 'stats | search <q> | inspect <id> | ...' },
  handler: ({ agent, rawInput }) => {
    // rawInput 是命令名之后的全部字节（含前导空白）
    return { kind: 'success', text: '...' }   // 或 { kind: 'error', text: '...' }
  },
})
```

- 命令行第 0 字节必须是 `/`，随后是小写名称，再之后输入末尾或空白。**名称之后的每个字节（包括分隔空白）都是 `rawInput`，由命令自己解析。**
- **handler 里不创建模型消息**，直接对 agent 执行。
- 同一作用域内**重复注册同名命令会抛异常**。
- 可选 `recordInput`（默认 true）：设 false 时不把输入记进会话日志。
- 可选 `input.attachments`：声明如何接受图片和文件附件（记忆系统不需要）。
- `agent.ctx.commands.register(...)` 可以只对该 agent 注册。

### A.1.4 `ctx.jobs`（✅ 部分）——约定包 `@deepseek-ai/dsh-jobs`，实现包 `dsh-jobs-local`

- 生产方（我们）通过注册去**启动**任务；`JobRegistry` 是抽象 Cordis 服务，**直接加载类会抛异常**，必须有实现包在场。
- 返回的 id 形如 `<kind>-N`（例：`bash-1`），**id 可预测，所以是授权边界而非保密边界**：任务属于启动它的 agent 会话，其他 agent 读不到也停不掉。
- `register()` 的实现里（`dsh-jobs-local/lib/index.js` 第 412 行起）校验：`spec.kind` 必须是非空字符串；`spec.label` 必须是非空字符串；id 由 kind 加一个自增计数拼成。
- ⚠️ **未证实**：`spec` 上"拉取源""push 块""字节上限""ownerId"等字段的确切名字与类型。**M3-T2 之前必须实测。**
- **重要判断：记忆系统不应该用 `ctx.jobs`。** 理由：`ctx.jobs` 的任务是**归属于 agent 会话**的、模型可以看到和 kill 的后台作业；而我们的 distill / consolidate / maintain 是**插件自己的内部维护工作**，不该出现在模型的 `job_list` 里、也不该能被模型 kill。→ **改用插件内部调度器（§5.12 的 `src/jobs/scheduler.ts`），基于 `setTimeout` / `setInterval` 并且用 `ctx.on('dispose')` 清理。** 只有当 DSH 明确要求"长时间工作必须走 jobs 以便应用退出时正确收敛"时，才回头评估。
  - **额外提醒：** 由进程内注册表管理的任务会随 harness 进程终止而消失；跨重启的持久执行需要别的后端。这也支持我们自己管调度 + 用 `jobs` 表持久化状态的做法。

### A.1.5 `ctx.sessions`（✅）——包 `@deepseek-ai/dsh-session`

```ts
ctx.sessions.create(sessionId, { meta: { cwd: '/workspace' } })
ctx.sessions.get(id)          // 实时会话
ctx.sessions.list()           // 全部实时会话，按创建顺序
ctx.sessions.fork(source, boundary?, childSessionId?)
ctx.sessions.flush(session)   // 持久性屏障：等所有持久化监听器结算
```

- `session.append(type, data, opts?)`：提交类型化事件。**表层事件（`system/message`、`developer/message`、`user/message`、`assistant/message`、`tool/result`）必须带 `surfaceOp`**（例如 `{ surfaceOp: 'append' }`）。
- `session.deriveMessages()`：把日志投影为模型看到的消息数组（带缓存）。
- `session.seq` 读当前日志长度（**不要物化数组**）。
- `session.eventAt(seq)` / `session.snapshotEvents()` / `session.ownEvents()` **已废弃**（deprecated）。新代码不要用它；需要长度就用 `session.seq`。仓库测试文件才可以在限定 lint 豁免下用。→ **我们的回填功能应该直接读磁盘文件，不要经过 Session 对象。**
- `session.header.cwd` 可读（见 `ctx.systemPrompt.variable('cwd', ({agent}) => agent?.session.header.cwd)`）。
- 会话 id 形如 `session-<uuid>`。

### A.1.6 `ctx.agents` 与 `Agent`（✅）——包 `@deepseek-ai/dsh-agent`

```ts
const handle = await ctx.agents.create({ sessionId, agentOptions: { provider, model } })
ctx.agents.resume(...)   // 加载持久化会话并重建 agent
ctx.agents.get(id) / list() / roots() / isOwnedBy(id, parent)
ctx.agents.withInitiator(agent, ...) / withoutInitiator()
await handle.dispose()
```

`Agent`（模型侧输入接口，全部是**带标识的 user 角色消息**）：

| 方法 | 语义 |
|---|---|
| `followup(msg)` | 排队一条普通的下一个**轮次**提示词，并**唤醒驱动器** |
| `steer(msg)` | 提交下一步输入，并**唤醒驱动器** |
| `inject(msg)` | 添加面向模型的上下文，**但不唤醒驱动器**，因此它落在**下一个被接纳的步骤**中 |
| `cancel(cause)` | 中止当前活动；未设 `keepInbox` 时清除待处理工作 |
| `whenIdle()` | 等整个 agent 完全停稳 |

消息形状（从实测的会话日志里抄的真实样例）：

```ts
{ content: [{ type: 'text', text: '...' }], source: { kind: 'user' } }
{ content: [{ type: 'text', text: '...' }], source: { kind: 'plugin', plugin: 'dsh-memory' } }
```

`source.kind` 的合法取值里已确认存在 `'user'` 和 `'plugin'`（后者见 `dsh-session-format-v1-to-v2/lib/index.js:641`）。**本项目的扩展来源约定是 `{ kind:'plugin', plugin:'dsh-memory', memoryRefs:[{id,contentRev}] }`。** 本机 `createUserMessage` 保留整个 source，Session 的 user 消息校验只要求 source.kind 为非空字符串（`dsh-session/lib/index.js:1191-1213`）；纯内存工厂调用及 JSON 往返已保留 memoryRefs。**这不是端到端落盘验证：M0-T2 必须确认扩展字段穿过实际 pre-step/持久化路径后仍原样存在。**

`Agent.ctx` 是该 agent 的作用域上下文；通过它注册的工具、提示词段、变量、事件监听器、限制**对该 agent 及其作用域继承链生效，agent 释放时全部撤销**。这些 effect 归 agent 所有，不自动归本插件所有；插件必须保存自身创建的 disposer，在插件停用/热重载时也撤销它们。

---

## A.2 事件

### A.2.1 `agent/*` 事件（✅）——由 `dsh-agent` 的 `agentEvents` 分发器发出

分发器内部实现（`dsh-agent/lib/index.js` 第 242 行起）用 `ctx.events.dispatch` 派发，并在 payload 上**自动注入 `agent` 字段**。三种 mode：

| mode | 语义 | 监听器约定 |
|---|---|---|
| `emit` | 通知 | 无需 `next()`；监听器抛出的异常被捕获并记 `warn`，**不会传播** |
| `serial` | 串行 | 监听器按序执行；返回值被 `await` |
| `waterfall` | 瀑布 | 监听器**必须调用 `next()`**，可改写返回给下游的值 |

**经验证的用法**（照抄自 `installModelSelection`，`dsh-agent/lib/index.js:193`）：

```ts
agentCtx.on('agent/pre-step', async ({ agent, messages, signal, step }, next) => {
  const decision = await next()
  if (decision.kind === 'reject' || signal.aborted) return decision
  return { ...decision, messages: [...decision.messages, extraMessage] }
}, { prepend: true })
```

**`agent/pre-step`：**
- payload：`{ agent, messages, signal, turn, step }`（`messages` 是本步的候选消息，`step` 在每个 turn 内从 1 开始，`signal` 是 `AbortSignal`）。
- 返回 `PreStepDecision`：**要么是 `{ kind: 'reject' }`，要么是 `{ kind: 'enter', messages, startsRequestSeries? }`**。
- enter 分支的 `messages` 是**完整、带标识且冻结的**消息批次。
- **包装下游 enter 的监听器必须保留 `startsRequestSeries` 声明与批次，除非有意替换其中一项** → 所以我们的返回必须写成 `{ ...decision, messages: [...] }`，**绝不能重新构造一个只有 `messages` 的对象**。
- `{ prepend: true }` 让监听器排在最前。

**`agent/turn-stopping`（✅ serial）：** "在本可完成的轮次关闭前运行，并可通过 steer 使其保持打开"。**它没有 `next()`**（是 serial 而不是 waterfall）。→ 我们的 turn-stopping 监听器**必须极快返回**，绝不能在这里做同步的 outcome 计算。

**`agent/request`（✅ waterfall）：** 用于改写模型请求（provider / model / reasoningEffort 等）。实测样例：

```ts
agentCtx.on('agent/request', async (_payload, next) => {
  const resolved = await next()
  const { reasoningEffort: _inheritedEffort, ...rest } = resolved
  return { ...rest, provider: selected.provider, model: selected.model }
})
```

**`agent/request-error`（✅）：** 让监听器重试失败的模型请求。

**其他已确认存在的事件名：** `agent/assistant-stream`（带有序 start / 临时分片 / end frame，分片索引从 0 起密集递增）、`agent/status`、`agent/created`、`agent/disposed`、`agent/inbox/inserted`、`agent/inbox/claimed`、`agent/inbox/discarded`。

### ✅ A.2.1.1 结论：改用改写 `decision.messages`，不要用 `agent.inject`

> **这一条已从源码完全确认，不是推测。** 原方案 §6.3 里"方式 A / B / C 三选一"的悬念到此结束：**只用改写路线，A 和 C 都排除。**

**证据链（全部来自 `@deepseek-ai/dsh-agent-loop/lib/index.js`）：**

1. `inject()` 的实现（第 812 行）：`inject(input) { this.send(input, "next-step", false); }` —— 拆进 inbox 的 `next-step` 队列，`wakeup = false`。
2. `preStep()` 的实现（第 906 行）：**先 `claim`，再跑 waterfall**：
   ```js
   async preStep(target, position) {
     const claimed = this.inbox.claim(target, position.turn)      // ← 队列在这里已被取空
     ...
     const decision = await this.dispatch.waterfall("agent/pre-step", { messages: claimed, ...position, signal })
   }
   ```
3. 因此**任何在 pre-step 监听器里调用的 `inject()`，追加的消息都已错过本次 claim**。对首步注入而言这不是"延迟一步"，而是**这次注入根本不会出现在本次请求里**。
4. **DSH 自己就是这么做的**——runtime-context 功能在 waterfall 的默认 enter 分支里往 `decision.messages` 追加：
   ```js
   () => Promise.resolve({
     kind: "enter",
     messages: context === void 0 ? claimed : [...claimed, context],
   })
   ```
   它的 source kind 是 `{ kind: "runtime-context" }`（`const SOURCE = "runtime-context"`，第 218 行），并用这个 kind 认领自己的消息（`isOwned`，第 220 行）。

**所以正确写法（与 §6.3 的代码一致）：**

```ts
return { ...decision, messages: [...decision.messages, message] }
```

- 必须**展开 `decision`**，不能重建成 `{kind:'enter', messages:[...]}`——会丢掉 `startsRequestSeries` 声明。
- 追加在**末尾**（跟在真实用户消息后），不是最前面。
- 新消息必须由 `createUserMessage(...)` 构造，工厂内部用 `randomUUID()` 生成带品牌的消息 id 并深度冻结（§A.6.3）。**消息 UUID 不是记忆 id**，增量去重只读取 source.memoryRefs 中的完整记忆 id 与正文修订号（§A.5.5），不得把消息 UUID 或显示短码当作记忆引用。
- 消息 `content` **只放一个 text 块**——`textOf()` 的判定是 `content.length === 1 && block?.type === 'text'`（第 224 行），保持这个形状行为最稳。

**什么时候该用 `inbox.splice` 而不是改写 decision：** 工具循环里要影响**下一个** step 时（DSH 自己在第 1154 行这么做）；pre-step 里要影响**当前** step 时用改写 decision。两者别混。

---

> ⚠️ **M0-T2 的探测目标据此改写：** 不再测"inject 是本次还是下次生效"（源码已回答）。改为**验证改写路径的细节**：(a) `decision.messages` 里各条的 `source.kind` 列表；(b) `decision` 上除 `kind`/`messages` 外还有哪些字段；(c) 注入消息落盘后的完整 `data.source.memoryRefs`、`data.id` 与事件 seq；(d) 注入消息相对 runtime-context 快照的先后位置；(e) 实际请求包含探测文本，投影在重启/重新折叠后仍还原相同的完整引用；(f) failed compaction 不移除引用，成功的局部 replacement 只移除被覆盖的注入。详见 PLAN.md §7 的 M0-T2。**缺失 memoryRefs 或只留下 UUID/短码不能判定增量注入验收成功。**

**关键技术风险（M0 必须实测）：** enter 的 `messages` 是"**完整、带标识且冻结的**"批次，而且"**接纳不等于提交**"。要点：
1. 我们要**新建**一条消息（而不是改写已有消息）——新消息必须带 `id`，且**必须不与其他消息的 `MessageId` 重复**。
2. 冻结的是**下游返回的那一批**；我们返回的是新批次（`[...decision.messages, 我们的消息]`），其中新对象用 `createUserMessage` 构造并冻结。M0-T2 检查工厂生成的消息 id 与 source.memoryRefs 是否原样落盘，而不是另选手写 id 策略。
3. 领取语义："领取会从 inbox 移除候选消息，**领取后插入的消息则等待后续边界**"。→ 我们在 pre-step 里追加的消息不经过 inbox，所以不受这条约束，但要在日志里确认它是否留下了对应的 `user/message` 事件。

→ **pre-step 返回只代表提出候选批次，不代表已经提交。** 不在返回之前写“已注入”的投影或成功日志；由已提交的 `user/message` 驱动投影和 injections 记账。M0-T2 必须核对实际请求、事件落盘和引用重建三者一致。

### A.2.2 `session/event`（✅）

```ts
ctx.on('session/event', (session, event) => { ... })
```

- 这是**已提交事件的通知**（清单里写的是"post-commit、fire-and-forget"）。
- 实测到的调用样例：`dsh-session-persistence-jsonl/lib/index.js:408` 就是 `ctx.on("session/event", (session, event) => {...})`。
- 事件对象形状（从真实日志实测）：

```jsonc
{
  "type": "tool/call",
  "seq": 20,
  "time": 1790851985118,
  "data": {
    "turn": 1, "step": 1,
    "callId": "call_00_gZLt9WBwrdsjn4wPotcR4101",
    "name": "pwsh",
    "arguments": "{\"command\": \"...\"}"
  }
}
```

- **回调参数是 `(session, event)`**，不是单一参数对象。**记住这一点，写错了会静默失效。**
- 我们的监听器**只允许入队**，不做任何 await / 数据库操作 / 异常抛出（方案 §6.2）。

**实际 replacement 元数据（✅ 源码核实，不在 `data` 内）：**

```ts
{
  type: 'user/message',
  seq: 120,
  data: checkpointMessage,
  surfaceOp: { op: 'replace', startSeq: 20, endSeq: 80 },
  sourceEventSeqs: [compactionStartSeq, compactionSummarySeq, ...shadowedSeqs],
}
```

`dsh-compaction-basic/lib/index.js:634-660` 先写 `compaction/summary`，再提交上述替换消息。`sourceEventSeqs` 必须包含全部被覆盖 surface 节点，也可额外引用因果事件；**不是这个数组里的所有 seq 都被替换**。只对顶层 `surfaceOp.op === 'replace'` 的已提交 surface 事件处理可见性：注入记录的 seq 必须在闭区间 `[startSeq,endSeq]` 内且被 sourceEventSeqs 引用，才能移除。`compaction/start`、`compaction/end`、错误或取消本身不改变可见集合；失败路径也会写 end，不能据此清空。

### A.2.3 发送事件的辅助函数（✅）

- `agentEvents(ctx, agent, carrier?)` → 返回 `{ emit(name, payload), serial(name, payload), waterfall(name, payload, ...rest) }`。
- `emitAgentEvent(ctx, agent, name, payload)` → 单次通知，不分配保留式分发器。
- `assembleContextFor(agent, signal)` → `{ agent, scope: agent, ...(signal && { signal }) }`，用于提示词组装。

---

## A.3 真实会话日志里的事件类型（✅ 实测统计）

对 `--C-Users-Windows11-Desktop-fwq--/session-908430d3.../session.v4.jsonl.zstd`（1.85 MB，一个 3 轮 85 步的会话）逐事件统计：

| 数量 | 事件类型 |
|---|---|
| 96 | `tool/call` |
| 96 | `tool/result` |
| 86 | `session-log-deepseek/delivery-accepted` |
| 85 | `step/start` |
| 85 | `assistant/message` |
| 85 | `step/end` |
| 6 | `agent/inbox/spliced` |
| 5 | `user/message` |
| 3 | `turn/start` |
| 3 | `workspace/changes` |
| 3 | `turn/end` |
| 2 | `system/message` |
| 2 | `request/header` |
| 2 | `session/title` |
| 1 | `session`（header 行，不是事件） |
| 1 | `permission/preset` |
| 1 | `sandbox/mode` |
| 1 | `approval/policy` |
| 1 | `model/selection` |
| 1 | `request/context` |
| 1 | `session/title-llm-request` |
| 1 | `session/end-seed` |

**各类型的真实结构（抽样，供 §6.2 的映射表和 §5.11 的规则抽取使用）：**

```jsonc
// 用户消息
{"type":"user/message","seq":9,"time":1790851982681,"data":{
  "content":[{"type":"text","text":"..."}],
  "source":{"kind":"user","rpcId":"a3400029-...","clientTimeZone":"Asia/Hong_Kong"},
  "role":"user","id":"42e5ca8e-..."}}

// 助手消息（content 里同时含 reasoning 和 text 块）
{"type":"assistant/message","seq":19,"time":1790851985117,"data":{
  "turn":1,"step":1,
  "message":{"role":"assistant","content":[
    {"type":"reasoning","text":"..."},{"type":"text","text":"..."}]}}}

// 工具调用（arguments 是 JSON 字符串，不是对象！）
{"type":"tool/call","seq":20,"time":1790851985118,"data":{
  "turn":1,"step":1,"callId":"call_00_gZLt9WBwrdsjn4wPotcR4101",
  "name":"pwsh","arguments":"{\"command\": \"...\"}"}}

// 工具结果（工具名不在这里，要靠 toolCallId 回连 tool/call）
{"type":"tool/result","seq":21,"time":1790851985745,"data":{
  "turn":1,"step":1,
  "message":{"role":"tool",
    "source":{"kind":"tool","callId":"call_00_gZLt9WBwrdsjn4wPotcR4101"},
    "toolCallId":"call_00_gZLt9WBwrdsjn4wPotcR4101",
    "content":[{"type":"text","text":"..."}]}}}

// 步骤与轮次边界
{"type":"step/start","seq":7,"time":1790851982680,"data":{"turn":1,"step":1}}
{"type":"step/end","seq":24,"time":1790851986771,"data":{"turn":1,"step":1}}
{"type":"turn/start","seq":5,"time":1790851982645,"data":{"turn":1}}
{"type":"turn/end","seq":404,"time":1790852291732,"data":{"turn":1,"reason":{"kind":"completed"}}}

// 系统提示词（完整渲染文本，很长）
{"type":"system/message","seq":8,"time":1790851982681,"data":{
  "turn":1,"step":1,
  "message":{"role":"system","content":[{"type":"text","text":"You are an AI agent powered by DeepSeek Harness.\n\n..."}]}}}

// 请求头 / 请求上下文（含模型与工具 schema）
{"type":"request/header","seq":12,"data":{"header":{
  "config":{"provider":"deepseek-account","model":"deepseek-flash","reasoningEffort":"high","maxTokens":256000},
  "adapterDefaults":{"maxTokens":true},
  "tools":[{"name":"ask_user_question","description":"...",...}]}}}
{"type":"request/context","seq":13,"data":{
  "provider":"deepseek-account","model":"deepseek-flash",
  "contextWindow":1000000,"systemPromptUpdate":"in-history"}}

// 会话标题
{"type":"session/title","seq":14,"data":{"title":"...","messageSeqs":[9],"source":{"kind":"fallback"}}}

// 收件箱拼接（用户输入在这里出现一次）
{"type":"agent/inbox/spliced","seq":4,"data":{
  "target":"next-turn","start":0,
  "inserted":[{"content":[{"type":"text","text":"..."}],
    "source":{"kind":"user","rpcId":"...","clientTimeZone":"Asia/Hong_Kong"}}]}}
```

### ⚠️ A.3.1 必须注意的映射陷阱

1. **工具名不在 `tool/result` 里。** 结果只有 `toolCallId`。要把结果和工具名配对，必须先建 `callId → name` 映射（按 seq 顺序处理即可，`tool/call` 总是先出现）。
2. **`tool/call` 的 `arguments` 是 JSON 字符串**，要 `JSON.parse` 后才能取字段。
3. **`assistant/message` 的 `content` 含 `reasoning` 块**。抽取记忆文本时**必须过滤掉 `type === 'reasoning'`**，只取 `text` 块——否则会把模型的内部推理当成事实存下来。
4. **同一条用户输入会出现两次**：一次在 `agent/inbox/spliced` 里，一次在 `user/message` 里。**只处理 `user/message`，忽略 `agent/inbox/spliced`**，否则会重复入账。
5. **`session-log-deepseek/delivery-accepted` 占了 86 条（约 15%）**，是投递确认事件，与我们无关，**在映射阶段直接跳过**。
6. `workspace/changes` 只带 `{turn}`，不含变更内容。
7. **`session` 行是文件 header，不是事件**（没有 `seq`），但它有 `cwd` —— **回填时 workspace_id 直接取它，不要去解析目录名的 Unicode 转义**（方案 §7 M2-T4 的疑虑到此解决：header 里的 `cwd` 是 `"C:\\Users\\Windows11\\Desktop\\fwq"` 这种干净路径）。

---

## A.4 会话文件格式（✅ 实测，含一个必须处理的坑）

### 磁盘布局

```text
C:\Users\Windows11\.dsh\sessions\
  --<归一化后的 cwd>--\                    # 可读的项目目录；没有 cwd 时是 _no-cwd/
    session-<uuid>\
      session.v4.jsonl.zstd                # 当前格式（默认 zstd）
```

目录名的转义规则：非 ASCII 和特殊字符变成 `~` 加该字符的 **UTF-16 码点的十六进制大写**。实测真实目录名：

```text
--C-Users-Windows11-Desktop-fwq--
--C-Users-Windows11-Desktop-~4E2D~8F6C~7AD9~4F59~989D~63D2~4EF6--   （中转站余额插件）
--C-Users-Windows11-Desktop-~5C0F~8BF4--                             （小说）
--C-Users-Windows11-Desktop-~5F02~4E16~754C~7684~4F11~95F2~751F~6D3B-- （异世界的休闲生活）
```

**结论：目录名可以反解，但没必要**——每个文件的 header 行里有权威的 `cwd` 字段。**回填时用 header 的 `cwd` 算 `workspace_id`。**

### 文件 header（第一行，不是事件）

```json
{"type":"session","version":4,"id":"session-908430d3-c2ab-4b7d-b28f-3c4d8e50592c",
 "createdAt":1790851937149,"cwd":"C:\\Users\\Windows11\\Desktop\\fwq",
 "isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

### ⚠️ A.4.1 关键坑：会话文件是**多帧拼接**的 zstd，不是单一 zstd 帧

DSH 的实现原文：后端**自己拥有一套"拼接帧容器"**，以便"在**不暴露压缩机制**的情况下追加并恢复批次"（`dsh-session-persistence-jsonl/lib/index.js` 的模块注释）。

**实测验证（这决定回填代码能不能写对）：**

| 做法 | 结果 |
|---|---|
| `zlib.zstdDecompressSync(整个文件)` | 只拿到 **214 字节**（就是第一帧的内容） |
| 逐帧解压的旧采样规模（只作对照，不代表切帧算法正确） | **360 帧**，共 **1,985,032 字节**，567 行事件 |

只解第一帧会静默地丢掉 **99.99%** 的数据，而且**不报错**。这是最危险的一类 bug：dry-run 会显示"一切正常"，但什么都没导入。

**正确做法：按结构计算帧边界，不扫描 magic 子串。** 本机源码 `dsh-session-persistence-jsonl/lib/index.js:1300-1362` 的 `scanZstdFrames` 返回 `{frames:[{start,end}], tornStart?}`，算法如下：

1. 从 `offset=0` 开始，仅在**当前帧起点**检查小端 magic `0xFD2FB528`（字节 `28 B5 2F FD`）。完整头中 magic 错误或保留位非法 → 文件损坏，记录并跳过；EOF 截断当前帧的头/块/校验和 → 返回当前帧的 `tornStart`，保留前面全部完整帧。
2. 读取 1 字节 descriptor，`descriptor & 24` 必须为 0。计算 `contentSizeFlag=descriptor>>>6`、`singleSegment=(descriptor&32)!==0`、`checksum=(descriptor&4)!==0`、`dictionaryFlag=descriptor&3`。
3. 跳过其余帧头：window descriptor 长度为 `singleSegment ? 0 : 1`；dictionary id 长度为 `dictionaryFlag===3 ? 4 : dictionaryFlag`；content size 长度为 `contentSizeFlag===0 ? (singleSegment ? 1 : 0) : 1<<contentSizeFlag`。跳步前先检查剩余字节是否足够。
4. 循环读取 3 字节小端 block header：`lastBlock=(header&1)!==0`、`blockType=(header>>>1)&3`、`blockSize=header>>>3`。type=3 非法；type=1（RLE）payload 是 1 字节，否则 payload 长度为 blockSize。按长度跳过 payload，遇 lastBlock 后退出。**块内出现 magic 字节不是新帧。**
5. 若 checksum=true，再跳过 4 字节校验和；至此 `[start,offset)` 才是一帧，将它加入 frames，从 offset 继续解析下一帧。帧是否有效还必须由后续解压及校验和验证；结构长度扫描不是解压替代品。
6. 按这些**精确的完整帧范围**分别解压，按顺序喂给增量 JSONL 解析器；不要把各帧当成各自完整的 JSON 文本行。第一帧必须是唯一一条完整 header 行。完整帧全部消费后，若留下无换行终止的 JSONL 残片 → 损坏，不当作普通 EOF 恢复。
7. 只有存在结构解析得到的 tornStart 时，才能对 `src.subarray(tornStart)` **一次性**使用 Node `zstdDecompress` 的 `{finishFlush:constants.ZSTD_e_flush}` 恢复可用前缀（源码 `1395-1396,2937-2993`）。只接纳最后一个换行之前、能按 seq 连续解析的完整记录；最后半行丢弃。该恢复失败时仅忽略撕裂尾帧，保留完整帧。
8. `fzstd` 回退若没有等价的“恢复不完整帧前缀”能力，**保守忽略 tornStart 之后的全部字节并输出 warning**；不要用完整帧解压器假装支持尾帧恢复。回填器只读日志，绝不截断或重写 DSH 的原文件。

**禁止**按 magic 的全文件出现位置切片、用 magic 次数校验帧数、逐步缩短尾部直到“解压成功”、或逐步扩大窗口试探边界。纯内存反例：一个合法 raw-block 帧的 payload 内含 `28 B5 2F FD`，整帧解压成功；magic 子串扫描产生两个“帧”，其中一个报 dictionary 错误。以长度结构定位边界不会受到该碰撞影响。

**M2-T4 必测 fixture：** 正常多帧、payload 含 magic（必须完整解出，不能错切）、校验和损坏的完整帧（拒绝）、头/块/校验和被截断的尾帧（保留已有完整帧）、恢复尾帧时最后半条 JSONL（忽略半条）、未压缩 `.jsonl`。Node 与 fzstd 分别验证其明确支持的恢复行为，不能只拿 dry-run 行数一致证明解码正确。

**压缩相关常量（✅ 源码确认）：**
- `ZSTD_MAGIC = 4247762216`（= `0xFD2FB528`）
- 写入时开校验和：`CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }`
- 未完成帧的刷新标志：`INCOMPLETE_FRAME_OPTIONS = { finishFlush: constants.ZSTD_e_flush }`
- 文件名后缀：`.jsonl.zstd`（zstd）或 `.jsonl`（不压缩）
- 配置项：`compression` 默认 `'zstd'`，可设 `'none'`
- **⚠️ 有些旧文件是 `.jsonl`（未压缩）**——回填器要同时支持两种后缀。

### 其他格式事实（✅）

- 会话日志根目录由 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `root` 配置项指定且**必填**（无默认值）。本机是 `C:\Users\Windows11\.dsh\sessions`。
- **DSH 提供"列出所有已存会话"的能力**（`dsh-session-persistence-jsonl/lib/index.js:2564` 附近有 `List every stored session visible to this process`）。**如果它暴露成插件可用的服务方法，回填器应该用它而不是自己遍历目录。** ⚠️ 需实测。
- 历史格式（v0、v1）用 packed Assistant delta 行；当前格式每行一个事件，并在 header 里存 `isSeeded`。**回填器只支持 v4**；遇到 `version != 4` 的文件跳过并在 `NOTES.md` 里记一行。

---

## A.5 离线 LLM（⚠️ 未证实）

- 本机 provider 配置在 `~/.dsh/profiles/desktop/cordis.patch.yml`，实测存在两个 provider：
  - `sub2api-deepseek` → `baseURL: http://127.0.0.1:18089/v1`，`api: openai-completions`，模型含 `deepseek-ai/deepseek-v4-flash-0731`
  - `amd-deepseek` → `baseURL: https://developer.amd.com.cn/radeon/api/v1`，模型含 `DeepSeek-V4.1-Flash`
- 密钥通过 `apiKeyEnv` 指定的**环境变量**传递（`SUB2API_DEEPSEEK_API_KEY` / `AMD_DEEPSEEK_API_KEY`），**配置文件里没有明文密钥**。
- 真源在 `~/.dsh/settings.yaml.imported`。
- ⚠️ **未证实**：是否存在供插件直接调用的 `ctx.llm` 服务。M3-T1 必须先查这个；**如果存在，优先用它**（这样插件完全不接触密钥，也不会绕过用户的 provider 配置）。
- **绝对不要读 `~/.dsh/.credentials.yaml`。**

---

## A.5.5 会话投影（`ctx.sessionProjections`）（✅ 推荐用）

第一方插件 `time-context` 用 `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply })` 维护"本 session 的插件私有状态"，**状态从会话日志 folded 出来，所以进程重启后能重建**。

```ts
ctx.sessionProjections.register({
  key: 'memoryState',
  stateVersion: 2,                               // 废弃旧 UUID 去重缓存，重折叠日志
  stateSchema,                                  // M0 验证可用的 schema 库
  init: () => ({ visibleInjections: [] }),
  apply: foldMemoryVisibility,                    // 按下列规则实现的纯函数
})
const state = ctx.sessionProjections.stateOf(agent.session, 'memoryState')
```

**持久引用与投影规则（必须实现，不再采用 UUID 集合或一遇压缩就清空）：**

- 消息 source 的 `memoryRefs` 存完整引用 `{id:string,contentRev:正安全整数}[]`。`id` 是完整的 `m_*` 主键；`contentRev` 对应 `memories.content_rev`（默认 1，仅 content 或 summary 真正变化时递增）。效用、计数、状态或版本快照变化不单独递增 content_rev；恢复旧内容也按当前修订号递增，不倒退。
- 投影 `visibleInjections` 的每项是 `{messageId,seq,refs}`：messageId 用于识别注入消息，seq 定位其 surface 节点，refs 存 source.memoryRefs。已提交的本插件 `user/message` 才能加入；返回 pre-step decision 不加入。
- 每个事件先按 §A.2.2 的实际 replacement 规则移除真正被覆盖的旧项，再考虑该事件是否加入新的本插件注入。去重集合由当前 visibleInjections 的 refs 推导，key 固定为 `` `${id}@${contentRev}` ``。一个引用出现在两条仍可见消息中时，覆盖其中一条不能删掉另一条提供的去重键。
- `compaction/start`、`compaction/end`（包括 error/cancel）、`compaction/summary` 本身不清空。成功 replacement 才移除其闭区间内、确实被覆盖的节点；摘要若只含短码/普通正文，不冒充拥有完整引用的插件注入。
- 引用缺失、格式非法、只有消息 UUID 或显示短码 → 不计为有效注入，记录诊断；禁止猜测/查短码来恢复“成功”。M0-T2 若当前 DSH 路径丢失扩展字段，暂停动态注入实现并修正适配层，不能静默切到旧错误方案。
- stateVersion=2 使旧状态缓存失效，按日志重新折叠；旧消息缺少 memoryRefs 时无法恢复有效引用，可在新的首步按预算补注一次。验收覆盖重启/重新折叠、fork 继承日志、正文修订后可再次注入、失败压缩不重注以及成功局部 replacement。

- ⚠️ **待确认**：`stateSchema` 用什么库（time-context 用的是 `zod` 的 `z.object`，而插件配置用的是 `@deepseek-ai/schemastery`）。**M0-T3 实测**；两者都是已安装依赖，选能跑通的那个。
- 注册后必须能在 `apply` 里通过 `stateOf` 读到，否则会抛 "cannot read ... state: its projection registration is not active"（inbox 的实现里见过这个错误）。

---

## A.6 插件入口形状（✅ 已验证）

### A.6.1 入口形状与适配层边界

`@deepseek-ai/dsh-time-context/lib/index.js` **就是我们要做的事的第一方参考实现**——它同样在 `agent/pre-step` 里往 decision 追加一条消息。**M0-T3 写骨架时直接参照它。**

下面只示意导出与文件路由；Config 字段和 Context 类型按 M0 核实结果补齐，不能把占位注释当作完整实现。

```ts
// src/dsh/plugin.ts: DSH imports 只能出现在 src/dsh/
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const name = 'dsh-memory'
const inject = ['agents', 'sessionProjections', 'systemPrompt', 'tools', 'commands']
const Config = z.object({ /* 经核实的配置 schema */ })

function apply(ctx, config) {
  // ... 注册监听器、工具、命令 ...
}

export { Config, apply, inject, name }             // 只在这里导出一次
```

```ts
// src/index.ts: 不直接 import @deepseek-ai/*
export { Config, apply, inject, name } from './dsh/plugin.js'
```

- **导出是具名的 `{ Config, apply, inject, name }`**——`name` 是非空、全局唯一的插件标识字符串；本项目消息来源单独约定在 source 中，并非由 name 自动生成。`inject` 声明实际使用的服务；若接入 `ctx.sessions` 或 `ctx.llm`，也必须声明对应依赖，不能仅照抄 time-context 的两个服务。`Config` 是 schemastery schema，`apply(ctx, config)` 是入口。**不得一边使用 `export const/function` 一边再次列出相同具名导出，避免重复 export 语法错误。**
- 对照：`dsh-system-prompt` 导出 `SystemPrompt as default`（是 Service 类），`dsh-tools` 导出 `ToolRuntime as default`。**两种形状都存在**，但**我们这种"注册监听器 + 工具 + 命令"的插件照 `time-context` 的具名导出写。**
- `Config` 用 `@deepseek-ai/schemastery`（`import z from "@deepseek-ai/schemastery"`）。`time-context` 的 Config 是 `z.object({ timeZone: z.string(), refreshIntervalMs: z.number() })`。

### A.6.2 source.kind 的取值有两种风格（★ 重要）

| 插件 | 注入消息的 source | 说明 |
|---|---|---|
| `dsh-time-context` | `{ kind: 'time-context', form: 'snapshot', sections: [...] }` | **kind 直接用插件名**，没有 `plugin` 字段 |
| 第一方 `goal`（v1→v2 迁移里） | `{ kind: 'plugin', plugin: 'goal' }` | 带 `plugin` 字段 |
| 第一方 runtime-context | `{ kind: 'runtime-context' }` | DSH 内部 |

**→ 本项目采用 `{ kind:'plugin', plugin:'dsh-memory', memoryRefs:[{id,contentRev}] }`**（在 goal 的来源形状上加完整引用），回声过滤与投影一致使用该形状。⚠️ **M0-T2 必须验证实际路径不拒绝/丢弃任何引用字段**。若必须换成 kind='dsh-memory'，同时保留并验证 memoryRefs、更新过滤和投影条件；把结果记录在 NOTES.md 后才能继续，不能把某条旧迁移代码当成新字段落盘证据。

### A.6.3 消息构造必须用 `createUserMessage`（★ 修正）

**不要手写 `{ id: crypto.randomUUID(), role: 'user', content: [...], source: {...} }`。** 用 DSH 提供的工厂函数（`@deepseek-ai/dsh-llm`）：

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const message = createUserMessage({
  content: [{ type: 'text', text: block }],
  source: {
    kind: 'plugin',
    plugin: 'dsh-memory',
    memoryRefs: sel.map(m => ({ id: m.id, contentRev: m.content_rev })),
  },
})
```

理由（✅ 源码确认，`dsh-llm/lib/index.js:36`、第 59 行）：

```js
function createMessage(input) {
  return deepFreeze(structuredClone({ ...input, id: brandString(randomUUID()) }))
}
function createUserMessage(input) { return createMessage({ ...input, role: 'user' }) }
```

- **id 是它自动生成的**（`brandString(randomUUID())`），我们不用管，也**不应该**自己传（传了会被 identity 品牌类型不匹配的问题绊住）。
- **memoryRefs 是插件的完整记忆引用，不是工厂的消息 id。** source 元数据的工厂及 JSON 往返已核实可保留，真实落盘仍受 M0-T2 门禁；这里只构造消息，成功记账在 `session/event` 提交通知时执行。
- **它做了 `structuredClone` + `deepFreeze`**。decision 的 `messages` 是"完整、带标识且**冻结**的批次"——我们自己手写的普通对象**没有冻结**，可能在别处被意外修改或触发 invariant 检查。
- **同族函数：** `createAssistantMessage`（source 自动是 `{kind:'model'}`）、`createDeveloperMessage`、`createSystemMessage`。**我们只用 `createUserMessage`**（记忆块是给模型看的上下文，用 user 角色）。

### A.6.4 本地包的挂载方式（⚠️ 仍待实测）

`~/.dsh/profiles/desktop/` 下**有 `package.json` 但 `node_modules/` 是空的**，且有 `pnpm-workspace.yaml` / `pnpm-lock.yaml`。所以 profile 是一个 pnpm 工作区。
   - `cordis.patch.yml` 里用的是 `name:` 加**裸包名**（例：`dsh-plugin-desktop`、`@deepseek-ai/dsh-client-ui-settings-general`），说明解析走 profile 的依赖。
   - ⚠️ **未证实**：能否用 `file:` 或绝对路径直接挂一个本地插件目录。**两条路都试一遍**：
     - **路线 1（推荐先试）：** 把插件目录加进 `~/.dsh/profiles/desktop/package.json` 的 dependencies（`"dsh-memory": "file:C:/Users/Windows11/Desktop/test/dsh-memory"`），然后在 profile 目录跑包管理器安装。
     - **路线 2：** 直接在 `cordis.patch.yml` 的 `insert` 列表里用绝对路径当 `name`。
   - **注意：`~/.dsh/profiles/desktop/cordis.patch.yml` 里含有用户的模型 provider 配置（含 API 端点）。修改前必须备份，只允许在文件末尾追加，不允许动已有任何一行。**

**首次安装必须用 insert（✅ 本机 composeEntries 已验证）：** 普通 id 条目是“修改现有项”，目标 id 不存在会 warn 并跳过（`dsh-app-boot/lib/index.js:73-98`），不会自动新增插件。安装依赖只负责解析模块，不能代替下面的首次插入。

```yaml
- insert:
    - id: dsh-memory
      name: dsh-memory
      config:
        dynamicBudgetTokens: 1600
```

**随后修改或停用才用 id 定向覆写：** 顶层是 YAML 数组；insert 里的元素支持 id/name/config/disabled，普通顶层元素则覆写此前已存在的 id。重复首次 insert 会重复创建插件，重跑安装时先检查是否已插入，不重复追加。

```yaml
- id: dsh-memory
  disabled: true
```

恢复启用追加同 id 的 `disabled:false`，不能只删掉一次停用覆写后假定所有更早的 disabled 都消失。配置覆写中的 config 是整体替换，不是深合并；修改时保留所需字段。先备份 patch/profile package 文件，只追加明确的新增/覆写条目，不改已有 provider 配置。

`config` 里允许 `!!js` 表达式。`package.json` 的 `dsh.profile` 里有 `bundles` 数组和 `patchReload: 'live'`（意味着改 patch 后可能热重载，不必重启）。

---

## A.7 待实测清单（M0 任务的全部内容）

| # | 要确认的事 | 在哪确认 | 影响 |
|---|---|---|---|
| 1 | 插件导出形状（`apply` / `inject` / default class） | 读小插件的 `lib/index.js` | 整个项目 |
| 2 | 本地插件怎么挂进 profile（`file:` 依赖还是路径 name） | 试两条路线 | 部署方式 |
| 3 | **改写 pre-step 的完整提交链**：批次 kind/decision 字段、source.memoryRefs 完整落盘、消息 id/seq、runtime-context 顺序、实际请求、重折叠引用，以及失败/局部压缩 | probe-inject + 结构化切帧解码 + fixture | 在线注入、持久去重及 content_rev 更新后的再注入 |
| 4 | `section()` disposer 在稳定层更新、插件停用及热重载时确实清理；同名不重复注册 | 已知源码契约 + M0-T3 实测 | 稳定层刷新与生命周期 |
| 5 | 是否存在 `ctx.llm` 服务 | 遍历包 README | 离线 LLM 客户端写法 |
| 6 | `node:sqlite` 与 FTS5 在 Electron 的 Node 里是否可用 | `probe.mjs` | 存储方案 |
| 7 | source.memoryRefs 扩展字段是否原样穿过真实持久化路径 | 工厂/Session 校验源码已核实，M0-T2 验证日志 | 注入回声过滤、完整引用投影 |
| 8 | 是否存在"列出所有已存会话"的插件 API | 读 persistence-jsonl 的 exports | 回填器实现 |
| 9 | 插件自己的数据该放哪（`storages/` 还是 `ctx.storageDomain`） | 读 `dsh-storage-domain` README | 数据目录 |
| 10 | `settings.yaml` 里的 provider 档位，选哪个模型做离线蒸馏 | 读 `~/.dsh/settings.yaml.imported`（**不读 .credentials.yaml**） | 离线 LLM 配置 |

---

## A.8 一句话总结给执行模型

> 本附录里标 ✅ 的表示已核实所述源码契约，标 ⚠️ 的仍需 M0 实测。首步注入走展开 decision + createUserMessage，不走 agent.inject；完整 `{id,contentRev}` 引用**只有在 M0-T2 通过后才能宣称随 source.memoryRefs 原样落盘**，已提交事件才记账，实际 replacement 才移除可见引用。zstd 必须按头/块长度结构定位帧，不按 magic 子串切割；首次安装必须 insert，后续停用才用 id 覆写。任何真实落盘或生命周期探测未通过，不能宣称在线接入已完成。
