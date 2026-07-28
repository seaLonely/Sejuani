# Sejuani Agent · 子代理派发（Sub-Agent Dispatch）设计蓝图

> 状态：设计定稿（未实施） · 范围：`src/core/agent/` 增量扩展
> 定位：让主 Agent 能把独立子任务派发给一次性子 Agent（对标 Claude Code 的 Task/subagent）
> 前置：Harness（H1-H4）、agent.task 工作流步骤、42 工具、多模型、记忆均已落地
> 约束：零新增运行时依赖；复用现有 AgentHarness/AgentBrain；确认语义零放松。

---

## 0. 背景

### 0.1 现状
- `agent.task`（工作流 StepKind）已是"一次性子 Agent"雏形，但只存在于**工作流编排层**，主对话 Agent 无法在会话内派发子任务。
- 主 Agent 处理复杂任务时只能自己串行跑，长上下文易漂移、无法并行、无法隔离探索。

### 0.2 目标
主 Agent 通过一个工具把定义清晰的子任务交给**独立子 Agent**执行：子 Agent 有自己的受限工具集、独立上下文（不继承主会话历史）、独立预算，跑完把结构化结果摘要回传主 Agent。支持一次派发多个子任务并行。

### 0.3 为什么有用（对标业界共识，非照抄某仓库）
- **上下文隔离**：子任务的大量中间探索不污染主会话历史（主 Agent 只拿结论）。
- **并行**：多个只读型子任务（如"分析模块 A"/"分析模块 B"）可 Promise.all 并发。
- **角色专注**：子 Agent 用更窄的工具白名单与更紧预算，聚焦单一目标。

---

## 1. 核心设计

### 1.1 新工具 `agent_dispatch`（新建 capabilities/subagent.ts）

```ts
// 工具参数
{
  tasks: Array<{
    goal: string;          // 子任务目标（自包含描述，主 Agent 需把必要背景写进来）
    allowTools?: string[]; // 子 Agent 工具白名单；缺省 = 只读工具集（含 code 只读）
    maxRounds?: number;    // 子 Agent 单轮工具循环上限，默认 6
  }>;
  parallel?: boolean;      // 多任务是否并行，默认 true（仅当全部子任务为只读白名单时才真正并行）
}
// readOnly: false（会触发子 Agent 执行，但本身不改外部状态由子工具决定）
// needsConfirm: false（派发本身无需确认；子 Agent 内部危险工具仍走确认/无人值守拒绝）
```

返回：每个子任务的 `{ goal, outcome, summary, toolCalls, todos }` 汇总文本，回传主 Agent 作为工具结果。

### 1.2 执行实现

```ts
// 每个子任务 = 一次性 AgentHarness（复用 R2-R4 成果）
const sub = new AgentHarness(config, {
  allowTools: task.allowTools ?? readOnlyToolNames(),
  grantedTools: [],                 // 子 Agent 不预授权任何危险工具
  aiRole: 'agentTask',              // 复用巡检角色模型（可配便宜模型）
  budget: { maxToolCalls: 20, maxWallClockMs: 3 * 60 * 1000 },
  maxIterations: 4,
  // 关键：不传 sessionId（独立上下文，不持久化不污染）
});
// 子 Agent 危险确认：继承父 ctx.confirm（交互模式在场确认；无人值守拒绝）
sub.getBrain().setConfirm(ctx.confirm);
const r = await sub.runGoal(task.goal);
```

### 1.3 深度守卫（防递归爆炸）

- `AgentContext` 新增 `subagentDepth: number`（主 Agent = 0）。
- 子 Agent 构造时 depth+1；`agent_dispatch` 执行前检查：`depth >= MAX_DEPTH(=1)` 则拒绝（"子代理不可再派发子代理"），返回错误结果而非抛异常。
- 即子 Agent **不能再调 `agent_dispatch`**（该工具对深度≥1 的子 Agent 不可见/直接拒绝）。

### 1.4 并行与串行

- `parallel && 全部子任务白名单只含 readOnly 工具` → `Promise.all` 并发；
- 否则串行（含写工具的子任务不并行，避免文件竞争）；
- 全局仍受父进程约束，不额外起进程（同进程内 await）。

---

## 2. 安全一致性

| 维度 | 约束 |
|---|---|
| 工具权限 | 子 Agent 白名单不得超出父可见工具；缺省仅只读 + code 只读 |
| 危险操作 | 子 Agent 危险工具走父 confirm 桥；无人值守（父无 confirm）一律拒绝，绝不静默 |
| 预授权 | 子 Agent `grantedTools` 恒空——不继承父会话授权，避免越权 |
| 递归 | MAX_DEPTH=1，子 Agent 看不到 agent_dispatch |
| 预算 | 每个子任务独立紧预算（缺省 20 工具调用 / 3 分钟） |
| 上下文 | 子 Agent 独立 history，不读主会话、不写 sessionStore；记忆按域共享（只读注入） |

---

## 3. 涉及文件

| 文件 | 改动 |
|---|---|
| `core/agent/capabilities/subagent.ts` | 新建：`agent_dispatch` 工具（派发 + 并行 + 深度守卫 + 结果汇总） |
| `core/agent/types.ts` | AgentContext 新增 `subagentDepth?: number` |
| `core/agent/brain.ts` | 构造子 Agent 时透传 depth+1；depth≥1 时从工具视图剔除 agent_dispatch |
| `core/agent/harness.ts` | HarnessOptions 增加 `subagentDepth` 透传给 brain |
| `core/agent/registry.ts` | 注册 subagentCapability |
| `core/agent/brain.ts` (system prompt) | 增加"复杂任务可用 agent_dispatch 拆分并行子任务"的引导 |

---

## 4. 交付与后续

- 本蓝图落盘 `docs/design/agent-subagents.md`，不改 src/ 代码（②仅设计）。
- 实施顺序建议：先 depth 守卫与类型 → subagent.ts 工具 → brain 视图过滤 → 冒烟（并行只读派发 / 深度拒绝 / 危险拒绝）。
- 与既有能力的关系：`agent.task`（工作流层）与 `agent_dispatch`（会话层）共用 AgentHarness 内核，互不替代——前者供无人值守巡检，后者供交互式复杂任务分解。

## 5. 假设

- 子 Agent 与主 Agent 同进程内 await（不起子进程），依赖 Node 单线程事件循环并发 I/O；
- 子任务目标需自包含（主 Agent 负责把背景写进 goal），子 Agent 不访问主会话历史；
- 深度上限 1（仅一层子代理），足够覆盖"主→并行子任务"的常见模式，避免递归失控。
