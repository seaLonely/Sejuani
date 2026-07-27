# Sejuani 工作流编排模块 · n8n 对标分期设计蓝图

> 状态：设计定稿（未实施） · 范围：`src/core/workflow/`、`src/server/`、`src/cli/` 增量扩展
> 前置：M1-M4 已落地（会话内直跑 / 产物落盘 / 重试 / skipIf / 流式 / 可观测性）
> 交付节奏：W1 → W4 四期，每期独立可交付；零新增运行时依赖（cron/表达式/水位全部手写）。

---

## 0. 背景：现状与 n8n 的差距

### 0.1 核心结论

- **接入 AI 后能否长时间运行？现状不能。** 执行是一次性模型（`flow run` / Agent 会话内跑完即止）；`sjn serve` 常驻但只被动响应 HTTP，无调度循环。
- **本蓝图补齐「编排层」**：现有引擎（DAG 拓扑 + checkpoint/resume + 产物 + 重试）即 n8n 的执行内核，缺的是触发器、调度器、流程控制、数据流与执行历史。

### 0.2 n8n 能力对标总表

| n8n 能力 | n8n 实现要点 | Sejuani 现状 | 本蓝图 |
|---|---|---|---|
| 图模型 nodes+connections | 节点多端口连线 | steps + dependsOn DAG | 沿用（不引入端口概念） |
| Trigger 节点（cron/webhook/事件/manual） | workflow.active 时注册 | 仅 manual | W1 TriggerSpec 五类 |
| 常驻调度 | 主进程注册 active workflows 触发器 | 无 | W1 scheduler（serve 宿主） |
| 表达式 `$json` / `$node["X"].json` | 完整 JS 求值 | 无（仅 fix 流 ctx 传递） | W2 受限点路径表达式（刻意收窄） |
| 执行历史 executions | DB 存每次执行 | 仅最近一次 state.json | W2 executions/ 目录存档 |
| If / Switch / Loop / Merge | 流程节点 | 仅 skipIf 二值枚举 | W3 when 条件 + flow.foreach |
| Wait 节点（落盘暂停+唤醒） | 定时/webhook 恢复 | 无 | W3 flow.wait 三模式 |
| errorWorkflow | 失败触发另一工作流 | 失败即停 | W3 spec.onFailure 收尾步骤 |
| AI Agent 节点 | LangChain 集成 | Agent 与引擎已互通（M1） | W4 agent.task 步骤 + 巡检模板 |
| 人工审批 | Wait for approval | 交互 confirm（在场时） | W4 waiting-approval 批准队列（无人值守） |

---

## 1. W1：触发器 + 常驻调度器（长时运行核心）

### 1.1 数据模型（core/workflow/types.ts）

```ts
export type TriggerSpec =
  | { type: 'manual' }                                       // 缺省，现状行为
  | { type: 'interval'; everyMinutes: number }
  | { type: 'cron'; expr: string }                           // 5 字段：分 时 日 月 周
  | { type: 'yunxiao.item'; pollMinutes: number;             // 轮询云效新/变更工单
      filter?: { itemType?: 'Bug' | 'Req' | 'Task'; statusName?: string; assignedToMe?: boolean } }
  | { type: 'webhook'; path: string };                       // POST /api/hooks/<path>

export interface WorkflowSpec {
  // …现有字段不变，新增：
  trigger?: TriggerSpec;      // 缺省 manual
  enabled?: boolean;          // 触发器是否激活（对应 n8n workflow.active）
}
```

### 1.2 cron 解析（新建 core/workflow/cron.ts）

```ts
/** 解析 5 字段 cron（分 时 日 月 周），支持 * 、/ 、, 、- 语法 */
export function parseCron(expr: string): CronSchedule;        // 非法表达式抛错（enable 时校验）
export function cronMatches(schedule: CronSchedule, date: Date): boolean;  // 每分钟 tick 比对
export function nextCronTime(schedule: CronSchedule, from: Date): Date | null; // triggers 列表展示用
```

### 1.3 调度器（新建 core/workflow/scheduler.ts）

```ts
export interface SchedulerOptions {
  /** 全局并发上限，默认 1（沿用「同时只跑一个工作流」约束） */
  maxConcurrent?: number;
  /** 同一 spec 触发重叠时的策略，默认 'skip'（记录 logEvent trigger.skipped） */
  overlapPolicy?: 'skip' | 'queue';
  /** 执行事件外发（复用 engine WorkflowEvent，供 serve 转 SSE） */
  onEvent?: (specId: string, e: WorkflowEvent) => void;
}
export interface SchedulerHandle { stop(): void; reload(): void; listActive(): ActiveTrigger[] }
export function startScheduler(config: SejuaniConfig, opts?: SchedulerOptions): SchedulerHandle;
```

关键行为：
- 启动扫描 `listSpecs()` 中 `enabled && trigger.type !== 'manual'` 注册触发器；每分钟 tick 驱动 cron/interval；
- `yunxiao.item` 轮询：按 filter 拉工单，与水位文件 `~/.sejuani/workflows/triggers/<specId>.watermark.json`（`{ seenIds: string[], lastPolledAt }`，seenIds 截断保留 500）比对，新命中逐条触发，触发上下文注入 `trigger.item`；
- 触发即执行：`buildStepContext` → 注入 trigger 上下文 → `runWorkflow(spec, ctx, { yes: false /* 无 confirm → 危险步骤走 waiting-approval，见 4.3 */ })`，执行记录写 W2 executions；
- 并发闸：同 spec 单飞；全局 maxConcurrent；重叠按 overlapPolicy；
- spec 目录 mtime 轮询（30s）自动 reload 触发器注册；
- 崩溃恢复：启动时将遗留 `running` 执行标记 `interrupted`（W2 状态机）。

### 1.4 宿主与触发面

- `sjn serve` 默认启动调度器，`--no-scheduler` 关闭（桌面端开着 = 自动化在跑）；
- `sjn flow watch`：纯调度前台模式（无 HTTP，服务器 nohup 场景）；
- CLI：`sjn flow enable <id>` / `disable <id>` / `triggers`（含下次触发时间，用 nextCronTime）；
- API：`POST /api/workflows/:id/enable|disable`、`GET /api/workflows/triggers`；
- webhook：`POST /api/hooks/:path`（server 新路由 routes/hooks.ts；body 注入 `trigger.payload`；同一 path 可同时用于 W3 wait.untilWebhook 唤醒）。

### W1 涉及文件

| 文件 | 改动 |
|---|---|
| `core/workflow/types.ts` | TriggerSpec + spec.trigger/enabled |
| `core/workflow/cron.ts` | 新建：5 字段解析/匹配/下次时间 |
| `core/workflow/scheduler.ts` | 新建：触发注册/tick/轮询水位/并发闸/reload |
| `core/workflow/store.ts` | activeSpecs() + 水位读写 |
| `cli/commands/serve.ts` | --no-scheduler；启动 scheduler |
| `cli/commands/flow.ts` | enable/disable/triggers/watch |
| `server/routes/workflows.ts` | enable/disable/triggers 端点 |
| `server/routes/hooks.ts` | 新建：POST /api/hooks/:path |

---

## 2. W2：数据流表达式 + 执行历史

### 2.1 受限表达式（新建 core/workflow/expr.ts）

```ts
export interface ExprContext {
  steps: Record<string, Record<string, unknown>>;   // = ctx.runOutputs
  trigger?: { type: string; item?: unknown; payload?: unknown; firedAt: string };
  env: { domain: string };
  item?: unknown;                                    // flow.foreach 迭代项（W3）
  failure?: { stepId: string; reason: string };      // onFailure 步骤（W3）
}
export function renderTemplate(text: string, ctx: ExprContext): string;
export function renderParams<T extends Record<string, any>>(params: T, ctx: ExprContext): T;
export function evalPath(path: string, ctx: ExprContext): unknown;   // when 条件求值用（W3）
```

- 语法：`{{steps.<id>.outputs.<key>}}`、`{{trigger.item.<field>}}`、`{{trigger.payload.<path>}}`、`{{env.domain}}`、`{{item.<field>}}`、`{{failure.reason}}`；
- **仅点路径取值 + 数组下标 `[0]`**，不做任意 JS 求值（对比 n8n 完整 JS 的刻意收窄：确定性、安全、零依赖）；
- 引擎每步执行前 `renderParams(step.params, exprCtx)`（渲染副本，不回写 spec）；未命中路径保留原文 + logEvent `expr.miss` 警告。

### 2.2 执行历史存档（store.ts 扩展）

```ts
export type ExecutionStatus = 'running' | 'ok' | 'failed' | 'interrupted' | 'waiting' | 'waiting-approval';
export interface ExecutionRecord {
  execId: string;                 // <specId>-<ts>-<rand>
  specId: string;
  trigger: { type: string; firedAt: string; item?: unknown; payload?: unknown };
  status: ExecutionStatus;
  state: RunState;                // 复用现有 checkpoint 结构
  startedAt: string;
  endedAt?: string;
  /** waiting 时的唤醒条件（W3 flow.wait 落盘） */
  wakeAt?: string;                // forSeconds 到时唤醒
  wakeWebhook?: string;           // untilWebhook 唤醒路径
}
export function saveExecution(rec: ExecutionRecord): void;      // executions/<specId>/<execId>.json
export function listExecutions(specId: string): ExecutionRecord[];
export function loadExecution(specId: string, execId: string): ExecutionRecord | null;
export function pruneExecutions(specId: string, keep = 50): void;
```

- 每次执行（手动/调度/Agent/批准恢复）都写独立存档；现有 `<id>.state.json` 保留「最近一次」语义（resume 与桌面端接口向后兼容）；
- API：`GET /api/workflows/:id/executions`、`GET /api/workflows/:id/executions/:execId`；CLI：`sjn flow history <id>`。

### W2 涉及文件

`core/workflow/expr.ts`（新建）、`store.ts`（executions 存档族）、`engine.ts`（renderParams 接入 + execution 记录写入）、`server/routes/workflows.ts`（executions 端点）、`cli/commands/flow.ts`（history）。

---

## 3. W3：流程控制节点

### 3.1 步骤级条件与级联（types.ts + engine.ts）

```ts
export interface WorkflowStep {
  // …新增：
  when?: string;        // W2 表达式路径，求值假值（undefined/false/''/0/空数组）→ skipped[条件不满足]
  alwaysRun?: boolean;  // 上游被跳过时仍执行（默认：直接上游 skipped 则本步级联跳过）
}
```

- 引擎顺序：resume 跳过 → skipIf → **级联检查**（直接 dependsOn 中存在 skipped 且非 alwaysRun → 级联跳过）→ **when 求值** → needsInput → 危险确认 → 执行；
- 级联规则修正现状「条件跳过不影响下游」：skipped 传染至下游（alwaysRun 逃逸），failed 仍即停（与现状一致）。

### 3.2 新控制 StepKind（steps/flow.ts 新建）

| kind | params | 行为 |
|---|---|---|
| `flow.foreach` | `items`(表达式取列表) / `subSteps`(步骤模板数组，禁嵌套 foreach) / `onItemError: 'stop'\|'continue'`(默认 stop) | 逐项串行执行子步骤（每项以 `{{item}}`/`{{item.<field>}}` 渲染），产物聚合 `outputs.results[]` |
| `flow.wait` | 三选一：`forSeconds` / `untilConfirm: true` / `untilWebhook: '<path>'` | forSeconds：execution 置 `waiting` + `wakeAt` 落盘并停止，W1 调度器 tick 到时自动 resume（对标 n8n Wait 落盘暂停）；untilConfirm：走 confirm 桥（在场确认）；untilWebhook：`POST /api/hooks/<path>` 命中 `wakeWebhook` 的 waiting 执行即 resume |

### 3.3 失败收尾（对标 n8n errorWorkflow）

```ts
export interface WorkflowSpec {
  // …新增：
  onFailure?: WorkflowStep[];   // 主链失败后执行的收尾步骤（如 notify.summary 评论工单）
}
```

- 主链任一步骤终态 failed 后顺序执行 onFailure（表达式可用 `{{failure.stepId}}`/`{{failure.reason}}`）；onFailure 自身失败仅 logEvent，不递归；执行结果并入同一 ExecutionRecord。

### W3 涉及文件

`core/workflow/types.ts`（when/alwaysRun/onFailure）、`steps/flow.ts`（新建 foreach/wait）、`steps/index.ts`（注册）、`engine.ts`（级联/when/waiting 状态/onFailure 链）、`scheduler.ts`（wakeAt 唤醒扫描）、`routes/hooks.ts`（wakeWebhook 唤醒）、`planner.ts`（步骤目录自动携带新 kind；REQUIRED_PARAMS 补 `flow.foreach: ['items']`）。

---

## 4. W4：AI 自主巡检模式

### 4.1 `agent.task` StepKind（steps/agent.ts 新建）

```ts
// params
{
  goal: string;          // 自然语言目标，支持表达式（如 "分析工单 {{trigger.item.identifier}} 并分类评论"）
  allowTools?: string[]; // 工具白名单；缺省 = 全部 readOnly 工具 + yunxiao_comment
  maxRounds?: number;    // 默认 6（低于会话默认 10，控制无人值守成本）
}
```

- 实现：构造一次性 AgentBrain（无历史、无 sessionId），注入**受限工具视图**（registry 过滤 allowTools）；`process(goal)` 后 `outputs = { reply, toolCalls: 摘要数组, usage }`；
- 安全：白名单外工具对 LLM 不可见；needsConfirm 工具在无人值守下自动拒绝并记入 outputs（不挂起——需人审的场景用 `flow.wait untilConfirm` 或依赖 4.3 危险步骤批准队列）。

### 4.2 内置巡检模板（templates.ts 追加）

| 模板 | 定义 |
|---|---|
| `patrol-yunxiao` | trigger: `yunxiao.item(pollMinutes:10)` → `agent.task("阅读工单 {{trigger.item.identifier}}，判断类型与紧急度，追加分类评论", allowTools:[只读+yunxiao_comment])` → `notify.summary(toComment)` |
| `daily-deps-report` | trigger: `cron("0 10 * * 1-5")` → `agent.task("检查组件用量与过期依赖，生成日报")` → `notify.summary` |

### 4.3 待批准队列（无人值守危险操作闭环）

- 调度执行中命中危险步骤（无 confirm 回调）→ execution 置 `waiting-approval` 落盘并停止（升级现状的「拒绝即失败」）；
- CLI：`sjn flow approvals`（列出待批准执行：spec/步骤/参数摘要）、`sjn flow approve <execId>`（交互确认后 resume）、`sjn flow reject <execId>`；
- API：`GET /api/workflows/approvals`、`POST /api/workflows/executions/:execId/approve|reject`；
- 桌面端 Workflows 页展示待批准队列（仅约定接口，前端对接另排）。

### W4 涉及文件

`steps/agent.ts`（新建）、`steps/index.ts`（注册）、`agent/registry.ts`（受限视图工厂 `getToolsFiltered(allow)`）、`templates.ts`（内置模板）、`engine.ts`（waiting-approval 状态）、`cli/commands/flow.ts` + `routes/workflows.ts`（approvals 族）。

---

## 5. 分期依赖与建议顺序

```
W1 触发器+调度器（长驻基座）
 └─→ W2 表达式+执行历史（W3 when/foreach 与 W4 goal 模板依赖表达式；调度执行需要历史存档）
      └─→ W3 流程控制（wait 定时唤醒依赖 W1 调度器 tick；when 依赖 W2 expr）
           └─→ W4 AI 巡检（agent.task 依赖表达式；批准队列依赖 W2 执行状态机）
```

执行状态机（W2 定义，W3/W4 扩展）：

```
running ──→ ok / failed / interrupted(崩溃恢复)
   │
   ├──→ waiting            （flow.wait forSeconds/untilWebhook；由调度器/webhook 唤醒 → running）
   └──→ waiting-approval   （无人值守命中危险步骤；approve → running / reject → failed）
```

## 6. 一致性约束（贯穿各期）

1. 零新增运行时依赖：cron/表达式/水位/存档全部 Node 内置能力手写；
2. 执行内核增量扩展：checkpoint/产物/重试/onEvent 全部沿用 M2 成果，不推倒重来；
3. 确认语义只加强不放松：无人值守危险步骤必须走批准队列，绝不静默执行；
4. 向后兼容：`<id>.state.json` 与现有 API 响应结构不变，executions/triggers/approvals 均为新增；
5. 表达式刻意不支持任意 JS（与 n8n 的差异化取舍）——复杂判断交给 agent.task 承担。

## 7. 兼容性假设

- 长驻宿主复用 `sjn serve`（桌面端启动即带调度器），不引入 pm2 等进程管理；
- 云效事件采用轮询水位方案（云效 OpenAPI 无可用推送 webhook 的前提下）；
- 调度器 tick 精度为分钟级（cron 5 字段语义），interval 最小 1 分钟。
