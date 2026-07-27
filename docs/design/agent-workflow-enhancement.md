# Agent 与工作流能力增强 · 分期设计蓝图

> 状态：设计定稿（未实施） · 范围：`src/core/agent/`、`src/core/workflow/`、`src/core/aiClient.ts` 及两端接入层
> 交付节奏：M1 → M4 四期，每期独立可交付；实施均沿用「tsc + 冒烟」验证基线，不引入新运行时依赖。

---

## 0. 背景与现状

### 0.1 现状盘点（2025-07 调研）

| 维度 | 现状 |
|---|---|
| Agent 能力 | 6 个 Capability / 31 个工具（10 个 needsConfirm），静态注册于 `core/agent/registry.ts` |
| Agent 执行 | 非流式 Function Calling 循环，上限 10 轮，工具串行执行，history 超 60 条硬裁剪 |
| Workflow 步骤 | 11 种 StepKind（4 种 dangerous），`steps/` 目录按类别拆分 |
| Workflow 执行 | 拓扑排序后严格串行、失败即停、checkpoint 落盘可 resume |
| 会话形态 | REPL（inquirer 确认）与 serve（SSE 确认桥）双端，会话纯内存、无持久化 |

### 0.2 核心问题

1. **Agent↔Workflow 桥接为存根**：`workflow_plan/run/resume`（`capabilities/workflow.ts`）与 `taskflow_fix_bug`（`capabilities/taskFlow.ts`）只回一句「请去终端跑 `sjn xxx`」，Agent 无法在会话内规划/执行/监控工作流——尽管 engine 的 `RunOptions.confirm/promptInput` 回调接口与 brain 的确认桥完全同构。
2. **引擎能力缺口**：无重试；`StepContext` 运行时产物（`foundProjects`、`yunxiao.workBranch/mrUrl`）不进 checkpoint，跨进程 resume 后 `note-mr` 步骤会把 `{mrUrl}` 渲染成「(待生成)」；无条件跳过（`git.mr` 在无改动时只能 failed）。
3. **交互体验缺口**：无流式输出；会话不持久（serve 重启即失）；只读查询工具不能并行；同一工具每次都要确认；执行中无法取消。
4. **可观测性缺口**：无 token 用量、每轮耗时、工具成功率统计；步骤产物不对外暴露。
5. **确认尺度不一致**：`yunxiao_comment`（写远端）、`env_install_deps`（改磁盘）无需确认，而同级的 `yunxiao_transition` 需要。

---

## 1. M1：Agent 内直跑工作流（桥接打通）

目标：Agent 会话内完成「规划 → 审阅 → 执行 → 监控」全闭环。

### 1.1 StepContext 构建下沉 core

现状 `server/routes/workflows.ts:buildStepContext`（L44-68）与 `cli/commands/flow.ts:buildFlowContext` 重复实现同一逻辑。

新建 `src/core/workflow/context.ts`：

```ts
/** 扫描组件库/工程根，从 spec 各步 params.components 反推 selectedComponents */
export async function buildStepContext(
  config: SejuaniConfig,
  spec?: WorkflowSpec,
  opts?: { dryRun?: boolean; yes?: boolean }
): Promise<StepContext>;
```

- 内部复用 `core/discover.scanComponents(config, kind)`；
- `server/routes/workflows.ts`、`cli/commands/flow.ts`、M1 新增的 Agent 桥三端共用，删除两处私有实现。

### 1.2 引擎事件外发

engine 目前只写 stdout（logger），Agent 在 serve 进程内执行时输出不可见。

`src/core/workflow/engine.ts`：

```ts
export interface WorkflowEvent {
  type: 'step-start' | 'step-end' | 'workflow-end';
  stepId?: string;
  title?: string;
  status?: StepStatus;      // step-end 时携带
  reason?: string;
  index?: number;           // 第几步 / 总步数
  total?: number;
}

export interface RunOptions {
  // …现有字段不变，新增：
  onEvent?: (e: WorkflowEvent) => void;
}
```

- 在现有 `logEvent('step.start'/'step.end'/'workflow.end')` 埋点处同步调用 `onEvent`（try/catch 包裹，回调异常不影响执行）；
- 调用方（brain 桥）把事件格式化后转发到 `ctx.print` → REPL 打终端 / serve 走既有 print→SSE 通道。

### 1.3 AgentContext 扩展与 server 输入桥

`src/core/agent/types.ts`：

```ts
export interface AgentContext {
  // …现有字段不变，新增：
  /** 输入回调：工作流 needsInput 补全用；REPL 注 inquirerInput，serve 注 SSE 输入桥 */
  promptInput?: PromptInputFn;
}
```

server 输入桥（`src/server/hub.ts`）：

```ts
/** 向频道发布 input-request 事件并挂起，等待 POST /api/agent/input 应答文本 */
askInput(channel: string, message: string): Promise<string>;
```

- 与现有 `ask()`（布尔确认）同构：pending Map + 超时（沿用现有超时策略）；
- 新端点 `POST /api/agent/input { sessionId, id, value }`（`routes/agent.ts`）；
- SSE 事件名 `input-request`，桌面端 Chat 页对接**另行排期**（本期仅约定接口）。

注入点：
- `cli/repl.ts`：`brain.setPromptInput(inquirerInput)`（`ui/prompt.ts` 已有实现）；
- `routes/agent.ts` 建会话时：`brain.setPromptInput((msg) => hub.askInput(channelOf(id), msg))`。

### 1.4 工具真实化

`capabilities/workflow.ts` 三个存根改为真实实现：

| 工具 | 新行为 |
|---|---|
| `workflow_plan(description, components?)` | `buildStepContext` → 按 `components` 名单解析 selectedComponents（缺省全部组件）→ `analyzeImpact` → `planWorkflow` → `saveSpec` → 返回步骤审阅文本（编号/kind/危险标记/needsInput 清单）+ specId，并提示「可用 workflow_run 执行」 |
| `workflow_run(workflowId)` | needsConfirm 保留；`loadSpec` → `buildStepContext(config, spec)` → `runWorkflow(spec, ctx, { dryRun:false, yes:false, resume:false, confirm: agentCtx.confirm, promptInput: agentCtx.promptInput, onEvent })` → 返回执行汇总（成功步数/失败原因） |
| `workflow_resume(workflowId)` | 同上，`resume: true` |

`capabilities/taskFlow.ts`：

- `taskflow_fix_bug(taskId, repoDir, targetBranch?)`：`repoDir` 改必填（LLM 缺参时自然追问用户）；真实执行——`getWorkItem` → `buildFixBugSpec` → 同上执行路径；
- 危险语义：spec 内的 dangerous 步骤（transition/mr）仍由 engine 经 `agentCtx.confirm` 逐步确认，双端确认桥复用。

收尾：删除全部「请运行 sjn xxx」存根文案；`brain.buildSystemPrompt` 增补「你可以在会话内直接规划并执行工作流（workflow_plan → workflow_run），执行中的危险步骤会逐一征求用户确认」。

### M1 涉及文件

| 文件 | 改动 |
|---|---|
| `core/workflow/context.ts` | 新建（buildStepContext） |
| `core/workflow/engine.ts` | RunOptions.onEvent + 埋点外发 |
| `core/agent/types.ts` | AgentContext.promptInput |
| `core/agent/brain.ts` | setPromptInput + system prompt 增补 |
| `core/agent/capabilities/workflow.ts` | plan/run/resume 真实化 |
| `core/agent/capabilities/taskFlow.ts` | fix_bug 真实化 |
| `server/hub.ts` | askInput 输入桥 |
| `server/routes/agent.ts` | POST /api/agent/input + promptInput 注入 |
| `server/routes/workflows.ts` / `cli/commands/flow.ts` | 改用 core buildStepContext |
| `cli/repl.ts` | 注入 inquirerInput |

---

## 2. M2：工作流引擎强化

### 2.1 步骤产物落盘（修复 resume 丢 mrUrl）

```ts
// steps/contract.ts
export interface StepExecResult {
  ok: boolean;
  reason?: string;
  /** 新增：步骤产物，进 checkpoint，resume 时回放到 StepContext */
  outputs?: Record<string, unknown>;
}

// workflow/types.ts
export interface StepResult {
  // …现有字段不变，新增：
  outputs?: Record<string, unknown>;
}
```

- 产物约定：`git.mr` → `{ mrUrl, workBranch }`；`project.find-users` → `{ foundProjects: string[] /* pkgName */ }`；
- engine 每步结束把 `res.outputs` 写入 `StepResult.outputs`（store.ts 序列化天然兼容，旧 state 文件无 outputs 字段照常读取）；
- `core/workflow/context.ts` 新增：

```ts
/** resume 时按已完成步骤的 outputs 回放运行时上下文（foundProjects / yunxiao.workBranch/mrUrl） */
export function hydrateContext(state: RunState, spec: WorkflowSpec, ctx: StepContext): void;
```

- engine 在 `initRunState` 之后、执行循环之前调用（仅 resume 分支）。

### 2.2 步骤重试

```ts
// workflow/types.ts
export interface WorkflowStep {
  // …新增：
  retry?: { max: number; delayMs?: number };
}

// steps/contract.ts
export interface StepDescription {
  // …新增：
  defaultRetry?: { max: number; delayMs: number };
}
```

- kind 级默认：`git.pull`、`yunxiao.comment`、`yunxiao.transition` 声明 `defaultRetry: { max: 2, delayMs: 3000 }`（网络类幂等/可安全重试）；`component.release`、`git.merge`、`git.mr` 等不可逆步骤**不设默认重试**；
- engine 执行段包重试循环：`attempts = (step.retry ?? handler.describe().defaultRetry)?.max ?? 0`，失败且未耗尽时 sleep(delayMs) 后重试，每次 `logEvent('step.retry', { attempt })`；耗尽才置 failed。

### 2.3 新步骤类型（steps/ 新增文件）

| kind | 文件 | params | dangerous | 说明 |
|---|---|---|---|---|
| `shell.run` | `steps/shell.ts` | `command`(必填) / `cwd` / `timeoutSec`(默认 300) | **是**（默认） | 复用 `core/exec.runCommandStream`；preview 展示完整命令与 cwd |
| `project.verify` | `steps/project.ts` 追加 | `command`(默认 "yarn build") | 否 | 对 `resolveTargetProjects` 逐工程执行验证命令，任一失败即步骤 failed（复用 runOverRepos） |
| `notify.summary` | `steps/notify.ts` | `toComment?: boolean` | 否 | 汇总本次 RunState 各步 outputs 渲染为文本；toComment=true 且有 `ctx.yunxiao` 时追加为工单评论 |

- `StepKind` 联合类型（workflow/types.ts）同步扩展；planner 步骤目录自动携带（describeAllSteps 动态生成，无需改 prompt）。

### 2.4 planner 自纠错

`core/workflow/planner.ts`：

```ts
const MAX_PLAN_RETRIES = 2;

// planWorkflow 内：
for (let attempt = 0; ; attempt++) {
  const raw = await chatJSON(messages);
  try {
    return normalizeSpec(raw, ctx, id);
  } catch (err) {
    if (attempt >= MAX_PLAN_RETRIES) throw err;
    logEvent('warn', 'plan.retry', { attempt, error: (err as Error).message });
    messages.push(
      { role: 'assistant', content: JSON.stringify(raw) },
      { role: 'user', content: `你返回的工作流未通过校验：${err.message}\n请修正后重新返回完整 JSON（仅 JSON，无解释）。` }
    );
  }
}
```

- `REQUIRED_PARAMS` 补全：`'yunxiao.transition': ['toStatusName']`、`'yunxiao.comment': ['content']`、`'shell.run': ['command']`（现仅 `git.merge: ['from']`）。

### 2.5 条件跳过（有限枚举，保持确定性）

```ts
export interface WorkflowStep {
  // …新增：
  skipIf?: 'no-changes' | 'no-targets';
}
```

- engine 在危险确认之前评估：`no-changes` → `!git.hasChanges(ctx.yunxiao?.repoDir)`；`no-targets` → 该步解析后的目标组件/工程为空；
- 命中则 `status: 'skipped'`、`reason: '[条件跳过] …'` 且**继续执行后续步骤**（与用户取消危险步骤的 skipped 用 reason 前缀区分，engine 的失败即停判断改为「failed 或非条件跳过的 skipped 才 break」）；
- fixBug.ts 的 `mr`/`note-mr`/`to-done` 三步声明 `skipIf: 'no-changes'`，替代现状 coder.fix 无改动时后续必然 failed 的体验。

### M2 涉及文件

`workflow/types.ts`、`steps/contract.ts`、`steps/{git,project,yunxiao}.ts`（outputs/defaultRetry 声明）、`steps/shell.ts`+`steps/notify.ts`（新建）、`steps/index.ts`（注册）、`engine.ts`（重试/skipIf/outputs 写入/hydrate 调用）、`workflow/context.ts`（hydrateContext）、`planner.ts`（自纠错+必填表）、`fixBug.ts`（skipIf 声明）。

---

## 3. M3：Agent 交互体验

### 3.1 流式输出

`core/aiClient.ts` 新增：

```ts
export async function chatWithToolsStream(
  messages: ChatMessage[],
  opts: ChatToolsOptions,
  onDelta: (text: string) => void
): Promise<ChatToolsResult>;
```

- 请求体 `stream: true`；手写 SSE 行解析（`data: ` 前缀、`[DONE]` 结束，跨 chunk 缓冲半行）；
- `delta.content` 即时回调 `onDelta`；`delta.tool_calls` 按 `index` 聚合 arguments 片段，流结束后组装为 `ToolCall[]`；
- 回落策略：HTTP 非 200、响应非 SSE（Content-Type 非 event-stream）时自动改调 `chatWithTools` 非流式（一次性 onDelta 全文）；
- `brain.process(input, opts?: { onDelta })` 透传；REPL `process.stdout.write` 逐段打印；`routes/agent.ts` 推 SSE `delta` 事件（前端逐字渲染另排）。

### 3.2 会话持久化 + 历史压缩

新建 `core/agent/sessionStore.ts`（目录 `~/.sejuani/agent-sessions/`）：

```ts
export interface AgentSessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
  stats?: AgentStats;      // 见 M4
}
export function saveSession(rec: AgentSessionRecord): void;
export function loadSession(id: string): AgentSessionRecord | null;
export function listSessions(): Array<Pick<AgentSessionRecord, 'id' | 'createdAt' | 'updatedAt'>>;
```

- brain 每轮 `process` 结束后保存（注入 sessionId 时才启用，REPL 默认临时会话可选 `--session <id>`）；
- **历史压缩**：`trimHistory` 升级——超过 60 条时，把待裁剪段（保持 tool_calls 序列完整的边界逻辑沿用现状）交 `chatJSON` 摘要为一条 `{ role: 'system', content: '[此前对话摘要] …' }` 插到 system prompt 之后；摘要仅尝试 1 次、失败退回现有硬裁剪（不阻塞主流程：压缩在本轮回复完成后异步进行）；
- `routes/agent.ts`：会话 Map 增加 TTL 清理（2h 无活动，setInterval 扫描）；新增 `GET /api/agent/sessions`（合并内存与磁盘列表）；`POST /api/agent/session` 支持 `{ resumeId }` 从 sessionStore 重建 brain history。

### 3.3 只读工具并行

```ts
// core/agent/types.ts
export interface AgentTool {
  // …新增：
  /** 只读工具（查询类）：同批 tool_calls 中可并行执行 */
  readOnly?: boolean;
}
```

- 标记 readOnly=true：repos 全部 5 个、`yunxiao_list_tasks/view_task/list_sprints/list_members`、`env_check/env_detect_pm`、`workflow_list/show/templates`、`coder_status`（共 13 个）；
- `brain.process` 工具执行段改为分组：把同批 tool_calls 按顺序切成「连续 readOnly 段（Promise.all 并行）+ 单个写类工具（串行）」交替执行；结果按原始顺序回填 history（tool_call_id 一一对应）。

### 3.4 会话级授权

```ts
// core/agent/types.ts
export type ConfirmAnswer = 'yes' | 'no' | 'always';
export interface AgentContext {
  // …新增：
  grantedTools: Set<string>;
  /** 三态确认；未注入时回落 confirm（布尔） */
  confirmEx?: (message: string) => Promise<ConfirmAnswer>;
}
```

- `brain.executeTool`：`needsConfirm` 时先查 `grantedTools`，命中直接放行；否则优先走 `confirmEx`，应答 `always` 则加入集合（仅会话内存，不落盘、不随 sessionStore 持久化——安全考虑）；
- CLI 端（`ui/prompt.ts` 新增 `inquirerConfirmEx`）：inquirer list 三选「是 / 否 / 本次会话内总是允许」；
- server 端：`/api/agent/confirm` 请求体增加 `always?: boolean`，hub.answer 透传三态（`hub.ask` 返回类型扩展为泛型或新增 `askEx`）。

### 3.5 取消/中断

- `core/aiClient.ts`：`postJson` 增加可选 `signal?: { aborted: boolean; onAbort(cb): void }`（轻量自定义，Node16 无全局 AbortController 依赖问题也可直接用 AbortController——Node 16.14+ 内置，确认 engines >=16 后用内置）；触发时 `req.destroy(new Error('已取消'))`；
- `brain` 增加 `abort()`：置 aborted 标志 + 终止当前 LLM 请求；工具循环在每个 tool 执行前检查标志，命中则以「用户已取消」结束本轮并清理挂起状态；
- REPL：执行中第一次 Ctrl+C 提示「再按一次中断」，第二次调 `brain.abort()`；
- server：新增 `POST /api/agent/abort { sessionId }`（busy 时生效，SSE 推 `aborted` 事件）。

### M3 涉及文件

`aiClient.ts`（stream/signal）、`agent/types.ts`、`agent/brain.ts`（onDelta/并行分组/授权/abort/压缩）、`agent/sessionStore.ts`（新建）、`ui/prompt.ts`（confirmEx）、`cli/repl.ts`（流式打印/双击中断/--session）、`server/hub.ts`（askEx）、`server/routes/agent.ts`（delta 事件/TTL/sessions/abort/input）。

---

## 4. M4：可观测性

### 4.1 token 用量

```ts
// aiClient.ts
export interface AiUsage { promptTokens: number; completionTokens: number; totalTokens: number }
export interface ChatToolsResult { /* …新增 */ usage?: AiUsage }
// chatJSON 返回值改为 { data: any; usage?: AiUsage }（或新增 chatJSONWithUsage 保持兼容，实施时二选一，倾向后者少动调用方）
```

- brain 会话累计 `stats: AgentStats = { rounds, toolCalls, promptTokens, completionTokens, startedAt }`；
- REPL 新增 `/stats` 命令；server 新增 `GET /api/agent/sessions/:id/stats`。

### 4.2 运行指标

- `RunState` 增加 `startedAt?/endedAt?`；engine 开始/结束时写入；
- engine 汇总段输出每步耗时（`endedAt - startedAt`）与总耗时；
- `GET /api/workflows/:id` 响应中的 state 自然携带 M2 outputs 与耗时字段（无需接口变更，桌面端 Workflows 页展示 mrUrl/耗时另排）。

### 4.3 工具调用审计

- `brain.executeTool` 追加写 `~/.sejuani/agent-sessions/<id>.audit.jsonl`（每行一条）：

```json
{ "ts": "…", "tool": "workflow_run", "argsDigest": "workflowId=chery-…", "success": true, "durationMs": 12345, "confirmed": "always" }
```

- `argsDigest` 做脱敏摘要（仅键名与截断值，绝不落 apiKey/token 类字段——按键名黑名单过滤）；复用 sessionStore 目录；无 sessionId（临时会话）时不写审计。

### M4 涉及文件

`aiClient.ts`（usage 解析）、`agent/brain.ts`（stats/审计）、`agent/sessionStore.ts`（audit 追加接口）、`cli/repl.ts`（/stats）、`server/routes/agent.ts`（stats 端点）、`workflow/types.ts`+`engine.ts`（RunState 时间戳与耗时输出）。

---

## 5. 分期依赖与实施顺序

```
M1 桥接打通 ──┬─→ M2 引擎强化（2.1 产物落盘使 M1 的会话内 resume 完整）
              └─→ M3 交互体验（3.1 流式 / 3.2 持久化相互独立，可与 M2 并行）
M4 可观测性 ←── 依赖 3.2 sessionStore（审计落盘位置）与 M2 outputs（运行指标展示）
```

建议排期：M1（1 期）→ M2 与 M3.1/3.2 并行（2 期）→ M3 余项（3 期）→ M4（4 期）。

## 6. 安全基线（贯穿各期）

1. dangerous 步骤与 needsConfirm 工具的确认语义**只加强不放松**：无 confirm 回调时一律拒绝（沿用重构后语义）；
2. `shell.run` 默认 dangerous，preview 必须完整展示命令与 cwd；
3. 修正现状确认尺度不一致：`yunxiao_comment`、`env_install_deps` 补上 `needsConfirm: true`（随 M1 一并落地）；
4. 会话级授权（3.4）仅内存生效，不持久化；审计日志（4.3）脱敏落盘；
5. 保持零新增运行时依赖：SSE 解析、会话存储、审计均用 Node 内置能力实现。

## 7. 兼容性假设

- LLM 端点（当前智谱 `glm-5.2`，baseURL `https://open.bigmodel.cn/api/paas/v4`）兼容 OpenAI 的 `stream` 与 `usage` 字段；不兼容时按 3.1 回落策略自动降级非流式；
- 旧版 `~/.sejuani/workflows/*.state.json` 无 outputs/时间戳字段，读取时视为 undefined，向后兼容；
- 桌面端前端（Chat/Workflows 页）对 delta/input-request/aborted 事件与 sessions/stats 接口的对接不在本蓝图范围，仅按上述契约预留。
