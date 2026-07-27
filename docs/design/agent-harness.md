# Sejuani Agent Harness 植入设计蓝图

> 状态：设计定稿（未实施） · 范围：`src/core/agent/` 增量扩展 + 三处入口接线
> 本期定稿：H1（自主循环 + todo 跟踪 + 预算闸 + 防循环熔断）；H2-H4 仅作分期预留
> 前置：Agent M1-M4（流式/会话持久化/受限工具视图）与工作流 W1-W4（agent.task/批准队列）已落地
> 约束：零新增运行时依赖；不改变现有 `sjn agent` 默认聊天行为。

---

## 0. 背景：为什么需要 Harness

Harness = 包裹 Agent「大脑」（AgentBrain）的执行外壳。成熟 coding agent 的关键能力不在模型本身，
而在外壳提供的生命周期控制、自我推进、成本护栏与防呆熔断。

### 0.1 现状差距

| Harness 能力 | 现状 | 差距 |
|---|---|---|
| 生命周期控制 | maxRounds / AbortFlag 中断 | 无目标驱动的跨轮自主推进（一问一答），无成本上限 |
| 任务规划 | 无 | 无 todo 分解与进度跟踪，长任务无机器可读的"完成"信号 |
| 防循环 | 无 | 同工具同参反复调用无检测；连续多轮零进展不会熔断 |
| 护栏 | 三态确认 / grantedTools / 白名单 / 批准队列 | （已足够，harness 不改动确认语义） |

### 0.2 设计原则

1. **外壳不入侵大脑**：AgentBrain 的对话/工具循环逻辑不重写，harness 以组合方式包裹（外层迭代 + 注入提示 + 读取 stats/todos）；
2. **一切终局有总结**：预算耗尽、熔断、迭代上限、中断，任何退出路径都让 LLM 产出"进度 + 未完成项"总结，绝不静默死循环或静默丢弃；
3. **确认语义零放松**：自主循环内危险工具依旧走 needsConfirm/grantedTools/白名单闸门，无人值守场景保持拒绝语义；
4. **零新增运行时依赖**。

---

## 1. H1：AgentHarness 外层循环

### 1.1 接口（新建 core/agent/harness.ts）

```ts
export interface HarnessOptions {
  budget?: BudgetSpec;
  /** 外层自主迭代上限，默认 8 */
  maxIterations?: number;
  /** 透传 brain：会话持久化 + 审计 */
  sessionId?: string;
  /** 透传 brain：受限工具视图（agent.task 场景） */
  allowTools?: string[];
  /** 透传 brain：预授权工具（白名单即授权边界） */
  grantedTools?: string[];
  /** 迭代/todo/预算/熔断事件外发（CLI 渲染 & SSE 转发） */
  onProgress?: (e: HarnessEvent) => void;
  /** 逐字流式输出透传（REPL/SSE delta） */
  onDelta?: (text: string) => void;
}

export interface HarnessEvent {
  type: 'iteration-start' | 'iteration-end' | 'todo-update' | 'budget-warn' | 'loop-warn' | 'finish';
  iteration?: number;
  todos?: TodoItem[];
  reason?: string;
}

export type HarnessOutcome = 'completed' | 'budget-exhausted' | 'stalled' | 'aborted' | 'max-iterations';

export interface HarnessResult {
  outcome: HarnessOutcome;
  iterations: number;
  /** 终局任务清单状态 */
  todos: TodoItem[];
  /** 末轮 LLM 总结（进度 + 未完成项） */
  summary: string;
  usage: AgentStats;
}

export class AgentHarness {
  constructor(config: SejuaniConfig, opts?: HarnessOptions);
  runGoal(goal: string): Promise<HarnessResult>;
  /** 透传 brain.abort() 并停止外层循环（REPL 双击 Ctrl+C / API abort 复用） */
  abort(): void;
}
```

### 1.2 循环时序

```
runGoal(goal)
 ├─ 0. 组装 goal 指令：目标原文 + harness 协议
 │     （"先用 todo_write 拆解任务；每完成一项更新状态；全部完成后明确说明"）
 ├─ 循环 iteration = 1..maxIterations：
 │    ├─ a. 预算闸 checkBudget(stats, startedAt)
 │    │     超限 → 注入收尾提示做最后一轮 → outcome=budget-exhausted
 │    ├─ b. 熔断闸 loopGuard.stalled()
 │    │     连续 2 轮无新工具签名且 todo 无变化 → 收尾 → outcome=stalled
 │    ├─ c. brain.process(首轮=goal 指令；续轮="继续执行未完成的 todo 项")
 │    │     （repeatedCall 警告在 brain 工具执行点内联注入，见 §4）
 │    ├─ d. 读 ctx.todos 完成度：
 │    │     全部 done/cancelled → 收尾总结 → outcome=completed
 │    │     LLM 未写 todo → 软判定：末轮无工具调用且回复含完成表述 → completed
 │    └─ e. emit iteration-end / todo-update
 └─ 达到 maxIterations → 收尾总结 → outcome=max-iterations
```

收尾总结统一实现：额外一次 `brain.process("总结当前进度、已改动内容与未完成事项")`，
其回复作为 `HarnessResult.summary`（abort 场景跳过 LLM 调用，用本地拼装的进度文本）。

---

## 2. H1：Todo 任务跟踪

### 2.1 数据与工具（新建 core/agent/todo.ts）

```ts
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in-progress' | 'done' | 'cancelled';
}
```

- 注册 2 个 Agent 工具：
  - `todo_write`：整表覆写（LLM 提交完整清单，简化合并语义）；`readOnly: false` 但 **不设 needsConfirm**（纯会话内状态，无外部副作用）；
  - `todo_read`：读取当前清单；`readOnly: true`（可并行）。
- 存储：`ctx.todos: TodoItem[]`（AgentContext 新增字段），随 sessionStore 持久化（SessionRecord 新增 `todos` 字段，向后兼容）；
- harness 判定完成的机器信号：`todos.length > 0 && todos.every(t => t.status === 'done' || t.status === 'cancelled')`；
- REPL 新增 `/todos` 命令渲染清单（含状态符号与进度比）。

---

## 3. H1：预算闸

### 3.1 接口（新建 core/agent/budget.ts，纯函数）

```ts
export interface BudgetSpec {
  maxTotalTokens?: number;   // prompt + completion 累计
  maxToolCalls?: number;
  maxWallClockMs?: number;   // 缺省 15 分钟（无人值守安全网）
}
export function checkBudget(
  spec: BudgetSpec,
  stats: AgentStats,
  startedAt: number
): { ok: boolean; reason?: string };
```

- 每轮外层迭代前检查，数据全部来自现有 `AgentStats`（promptTokens/completionTokens/toolCalls）与墙钟；
- 超限处理：注入"预算即将耗尽，请立即总结进度与剩余事项"提示做**最后一轮**（不再执行工具类续跑提示），终局 `budget-exhausted`；
- 缺省宽松：不限 token、不限调用、wallClock 15 分钟；由调用方按场景收紧（agent.task 巡检建议 `{ maxToolCalls: 30, maxWallClockMs: 5min }`）。

---

## 4. H1：防循环熔断

### 4.1 接口（新建 core/agent/loopGuard.ts）

```ts
export class LoopGuard {
  /** brain executeTool 处埋点（argsHash 复用 sessionStore.digestArgs，天然脱敏） */
  record(toolName: string, argsHash: string): void;
  /** 同 (tool+argsHash) 在滑窗（最近 12 次调用）内 ≥3 次 → 返回警告文本，否则 null */
  repeatedCall(): string | null;
  /** 外层迭代粒度：连续 2 轮无新工具签名 且 todo 无状态变化 → true */
  stalled(): boolean;
  /** 每轮外层迭代结束时快照（工具签名集 + todos 摘要） */
  snapshotIteration(todos: TodoItem[]): void;
}
```

- `repeatedCall` 命中：向 brain 历史注入 system 提醒（"你在重复调用 X 且参数相同，请换策略或说明原因"），**不中断**；同一签名再犯 → 外层熔断（outcome=stalled）；
- brain 侧埋点为最小改动：`executeTool` 内调用 `this.loopGuard?.record(...)`（harness 注入 guard 实例，普通聊天模式为 undefined 零开销）。

---

## 5. H1：入口接线（四处）

| 入口 | 行为 | 涉及文件 |
|---|---|---|
| CLI `sjn agent --goal "<目标>"` | 非交互自主模式：`AgentHarness.runGoal`，onProgress 渲染迭代/todo 进度，终局打印 HarnessResult（outcome/迭代数/todo 完成比/usage） | `cli/commands/agent.ts` |
| REPL `/goal <目标>` | 会话内启动自主循环，共享当前会话历史与授权集；双击 Ctrl+C 中断（复用 AbortFlag → harness.abort） | `cli/repl.ts` |
| W4 `agent.task` 步骤 | params 新增 `harness?: boolean`（缺省 false 保持现状）与 `budget?: BudgetSpec`；true 时走 runGoal，outputs 增加 `outcome`/`todos`——巡检从"跑一轮"变"跑到目标达成或预算耗尽" | `core/workflow/steps/agent.ts` |
| server `POST /api/agent/goal` | body `{ sessionId, goal, budget? }`；202 受理，进度经 SSE（复用会话频道：`harness-progress`/`delta`/`finish` 事件）；`POST /api/agent/abort` 复用 | `server/routes/agent.ts` |

## 6. 涉及文件总表（H1 实施范围）

| 文件 | 改动 |
|---|---|
| `core/agent/harness.ts` | 新建：AgentHarness/HarnessOptions/HarnessResult/HarnessEvent |
| `core/agent/todo.ts` | 新建：TodoItem + todo_write/todo_read 工具实现 |
| `core/agent/budget.ts` | 新建：BudgetSpec/checkBudget 纯函数 |
| `core/agent/loopGuard.ts` | 新建：LoopGuard（滑窗重复检测 + 迭代停滞检测） |
| `core/agent/types.ts` | AgentContext 新增 `todos`；工具注册类型无需变化 |
| `core/agent/brain.ts` | executeTool 埋点 loopGuard.record + system 提醒注入；暴露 ctx.todos 读取 |
| `core/agent/registry.ts` | 注册 todo_write/todo_read |
| `core/agent/sessionStore.ts` | SessionRecord 新增 todos 字段（向后兼容） |
| `cli/commands/agent.ts` | `--goal` 选项 |
| `cli/repl.ts` | `/goal` `/todos` 命令 |
| `core/workflow/steps/agent.ts` | `harness`/`budget` 参数分支 |
| `server/routes/agent.ts` | `POST /api/agent/goal` + SSE 进度事件 |

## 7. H2-H4 预留（后续期，仅概述）

| 期 | 主题 | 概述 |
|---|---|---|
| H2 | 验证回路（verify loop） | runGoal 收尾前执行 verify 命令（构建/测试/自定义，复用 project.verify 能力）；失败输出回喂 LLM 自修复重试 N 次；完不成则如实报告——"完成"从自我宣称变为可验证事实 |
| H3 | 快照与终局报告 | 执行前 git 快照、失败一键回滚；终局结构化报告（改动文件/验证证据/未完成项）落盘 `~/.sejuani/agent-sessions/<id>.report.md` |
| H4 | 经验沉淀 + evals | 成功模式/踩坑写入 `~/.sejuani/experience` 跨会话复用（system prompt 注入）；基准任务集录制回放，改 prompt/模型可量化对比 |

依赖关系：H2 依赖 H1 的收尾钩子；H3 的报告消费 H1 todos 与 H2 验证证据；H4 独立可并行。

## 8. 一致性约束

1. 确认语义零放松：harness 不绕过 needsConfirm/grantedTools/白名单；无人值守（agent.task）危险工具保持拒绝或走批准队列；
2. 任何终局（completed/budget-exhausted/stalled/aborted/max-iterations）都产出总结，绝不静默；
3. 现有行为不变：`sjn agent` 缺省仍是聊天模式；agent.task 缺省仍单轮；SessionRecord 新增字段向后兼容；
4. 零新增运行时依赖：滑窗/哈希/预算全部 Node 内置能力实现。
