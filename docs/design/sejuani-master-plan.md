# 瑟庄妮（Sejuani）编码智能体 · 终态总体架构蓝图

> 状态：设计定稿（未实施） · 定位：全局主蓝图（Master Plan），统摄既有分期蓝图与新增能力域
> 交付节奏：R1-R5 五期路线图；零新增运行时依赖；不改变现有命令缺省行为。

---

## 0. 终态定位

**面向前端开发的编码智能体**，五个支柱：

1. **有记忆**：跨会话长期记忆，3000 字符预算注入上下文（用户偏好/项目事实/经验教训）；
2. **可换模型**：多 profile 一键切换 + 按场景绑定不同模型（对话/规划/压缩/巡检各用其宜）；
3. **能自主编码**：内建编码工具集 + 外部 coder 委托的混合路线，配合 Harness 形成自主编码闭环；
4. **有完善编排**：工作流引擎 W1-W4（触发调度/表达式/流程控制/AI 巡检）——已落地；
5. **有完善入口**：CLI 30+ 命令 / REPL / Tauri 桌面 / HTTP API+SSE，云效任务管理深度集成——已落地。

### 0.1 蓝图关系索引

| 文档 | 范围 | 状态 |
|---|---|---|
| `agent-workflow-enhancement.md` | M1-M4：Agent 内直跑/引擎强化/交互体验/可观测性 | 已全部实施 |
| `workflow-orchestration.md` | W1-W4：n8n 对标编排层（触发/表达式/控制/巡检） | 已全部实施（v1.4.0） |
| `agent-harness.md` | H1-H4：Harness 执行壳（自主循环/验证/报告/经验） | 蓝图定稿，待实施 |
| **本文档（master-plan）** | S1-S3 新能力域 + 七层终态架构 + R1-R5 统一路线图 | 蓝图定稿 |

## 0.2 终态七层架构

```
┌ 交互层   CLI 30+ 命令 / REPL / Tauri 桌面 / HTTP API + SSE          [已有]
├ 编排层   工作流引擎 W1-W4：触发调度/表达式/流程控制/AI 巡检           [已落地]
├ 执行壳   Harness H1-H4：自主循环/预算熔断/验证回路/报告/经验沉淀      [蓝图定稿]
├ 大脑     AgentBrain：流式/多轮工具循环/三态确认/历史压缩              [已落地]
├ 能力层   7 组工具：repos/yunxiao/env/workflow/coder/taskflow + code  [code 新增·S3]
├ 记忆层   Memory：3000 字符注入预算 + 分类条目 + 自动沉淀              [新增·S2]
└ 模型层   多 profile OpenAI 兼容接入 + 场景绑定                       [新增·S1]
```

分层原则：上层只依赖下层；模型层与记忆层是全局横切资源（brain、planner、compress、agent.task 共享）。

---

## 1. S1：多模型接口（模型层）

### 1.1 数据模型（state/aiConfig.ts 扩展）

```ts
export interface AiProfile {
  name: string;
  baseURL: string;    // OpenAI 兼容端点（智谱/DeepSeek/Moonshot/Ollama…）
  apiKey: string;
  model: string;
}

export interface AiConfigState {
  profiles: Record<string, AiProfile>;
  /** 主对话缺省 profile */
  activeProfile: string;
  /** 场景绑定：不同角色用不同模型（如历史压缩用便宜模型） */
  roles?: {
    chat?: string;       // Agent 主对话
    planner?: string;    // 工作流 AI 规划（planWorkflow）
    compress?: string;   // 历史压缩摘要
    agentTask?: string;  // 无人值守巡检（agent.task）
  };
}
```

### 1.2 行为设计

- **协议统一 OpenAI 兼容**：`/chat/completions` + Function Calling + SSE 流式，不做多协议适配器（Anthropic 原生协议等不支持），保持零依赖；
- `aiClient.resolveAi(role?: 'chat' | 'planner' | 'compress' | 'agentTask')`：按角色查 roles 绑定 → 未绑定回退 activeProfile → 无 profiles 回退旧字段（迁移兼容）；
- 迁移：首次读取时把现有单配置（apiKey/baseURL/model）落为 `profiles.default` 并置 activeProfile='default'——旧命令 `set-key/set-base/set-model` 语义映射为改写 default profile；
- CLI：
  - `sjn ai-config profile add <名> --base <url> --key <k> --model <m>`
  - `sjn ai-config profile use <名>` / `rm <名>` / `list`（key 脱敏展示）
  - `sjn ai-config role set <chat|planner|compress|agentTask> <profile>`
- REPL：`/model <profile>` 会话内临时切换（不落盘），`/model` 查看当前解析结果。

### S1 涉及文件

`core/state/aiConfig.ts`（profiles/roles + 迁移）、`core/aiClient.ts`（resolveAi 按角色解析）、`core/agent/brain.ts`（chat/compress 角色接线）、`core/workflow/planner.ts`（planner 角色）、`core/workflow/steps/agent.ts`（agentTask 角色）、`cli/commands/ai.ts`（profile/role 子命令）、`cli/repl.ts`（/model）。

---

## 2. S2：记忆系统（记忆层，3000 字符注入预算）

### 2.1 数据模型（新建 core/agent/memory.ts）

```ts
export interface MemoryEntry {
  id: string;
  /** preference=用户偏好 project=项目事实 lesson=经验教训 */
  category: 'preference' | 'project' | 'lesson';
  /** 单条 ≤200 字符（写入时截断），保证预算内可容纳足量条目 */
  content: string;
  /** 注入排序权重：被引用/更新 +1，随时间自然衰减 */
  weight: number;
  updatedAt: string;
}

/** 注入 system prompt 的字符预算（存储无上限，注入时裁剪） */
export const MEMORY_BUDGET = 3000;

export function renderMemory(domain: string): string;      // 按 weight+时间排序拼接，截断至预算
export function upsertMemory(domain: string, entry: Partial<MemoryEntry> & { content: string }): MemoryEntry;
export function forgetMemory(domain: string, id: string): boolean;
export function listMemory(domain: string): MemoryEntry[];
```

### 2.2 行为设计

- **存储**：`~/.sejuani/memory/<domain>.json`——按域隔离（chery/foton/saas 记忆互不污染），JSON 单文件简单可靠；
- **注入**：`buildSystemPrompt` 追加「长期记忆」段（renderMemory 结果 ≤3000 字符）：
  - 排序：category 优先级（preference > project > lesson）内按 weight 降序、updatedAt 降序；
  - 超预算：淘汰低权重条目（不删存储，仅本次不注入）；
  - 注入段头部固定声明：「以下为长期记忆，供参考；与当前对话事实冲突时以现场为准」；
- **写入路径 ×3**：
  1. Agent 工具：`memory_write`（upsert，无需确认——纯本地状态）/ `memory_read`（readOnly）/ `memory_forget`；
  2. system prompt 协议：教 LLM 在「用户表达偏好、纠正错误、达成命名/流程共识」时主动 memory_write；
  3. H4 衔接：harness 经验沉淀直接写 `lesson` 类（同一存储，不做两套系统）；
- REPL：`/memory` 列表（含 id/类别/权重）、`/memory rm <id>` 手动清理。

### S2 涉及文件

`core/agent/memory.ts`（新建）、`core/agent/capabilities/memory.ts`（新建 3 工具）、`core/agent/registry.ts`（注册）、`core/agent/brain.ts`（buildSystemPrompt 注入 + 协议段）、`cli/repl.ts`（/memory）。

---

## 3. S3：内建编码工具集（能力层，混合委托路线）

### 3.1 新工具组（新建 core/agent/capabilities/code.ts，6 个工具）

| 工具 | 行为 | 安全 |
|---|---|---|
| `code_tree` | 目录结构概览（fast-glob，忽略 node_modules/dist/.git，限深） | readOnly |
| `code_read` | 读文件（可选行范围；>2000 行截断提示） | readOnly |
| `code_search` | 正则内容检索 + glob 文件查找（命中带行号上下文） | readOnly |
| `code_edit` | 精确文本替换（original 在文件内唯一匹配才执行，否则报歧义） | needsConfirm |
| `code_write` | 创建/覆写文件（覆写时确认信息附现有文件摘要） | needsConfirm |
| `code_shell` | 工作目录内执行命令（构建/测试/lint） | needsConfirm + dangerous |

### 3.2 安全与路线

- **工作区边界（硬校验）**：全部工具强制 `workDir` 参数；目标路径 `path.resolve` 后必须以 `fs.realpathSync(workDir)` 为前缀——拒绝 `..` 穿越与符号链接逃逸；workDir 本身须为已存在目录；
- **混合委托路线**：
  - 中小改动（读→搜→精确编辑→验证）：瑟庄妮用内建工具自主完成；
  - 大型任务：保留 `coder_delegate`（现有 coder 工具委托 claude/codex CLI）；
  - system prompt 选择准则：预估改动 >5 个文件、需要长时推理、或用户显式点名外部工具 → 委托；否则自主；
- **自主编码闭环**（终态核心形态）：
  `sjn agent --goal "修复 xxx"` → H1 自主循环拆解 todo → code_search/read 定位 → code_edit 修改（逐次确认或会话授权）→ H2 验证回路 code_shell 跑构建/测试 → 失败回喂自修复 → H3 终局报告；
- **无人值守基线不变**：agent.task 缺省白名单只含 readOnly code 工具（tree/read/search）；写类工具需 spec 作者显式 allowTools 声明（白名单即授权边界）。

### S3 涉及文件

`core/agent/capabilities/code.ts`（新建 6 工具 + 边界校验）、`core/agent/registry.ts`（注册）、`core/agent/brain.ts`（system prompt 委托准则段）、`core/workflow/steps/agent.ts`（缺省白名单说明更新）。

---

## 4. 统一分期路线图（R1-R5）

| 期 | 内容 | 依赖 | 价值 |
|---|---|---|---|
| **R1** | S1 多模型 profile + S2 记忆系统 | 无（纯地基） | 换模型自由 + 瑟庄妮开始"记得你" |
| **R2** | H1 Harness 骨架（自主循环/todo/预算/熔断） | R1（compress/agentTask 角色绑定可用） | 从聊天助手到目标执行体 |
| **R3** | S3 编码工具集 + H2 验证回路 | R2（验证回路挂 harness 收尾钩子） | **自主编码闭环**（核心里程碑） |
| **R4** | H3 快照回滚+终局报告 + H4 经验沉淀（写入 S2 lesson） | R3 | 可回滚、有交代、越用越聪明 |
| **R5** | 桌面端 UI 对接（记忆管理页/goal 进度/approvals/executions）+ evals 基准集 | R1-R4 | 产品化收口 |

依赖图：

```
R1 (S1 模型层 + S2 记忆层)          ← 地基，独立可先行
 └─→ R2 (H1 自主循环)              ← 压缩/巡检用上角色绑定
      └─→ R3 (S3 编码工具 + H2 验证) ← 自主编码闭环成立
           └─→ R4 (H3 报告 + H4 沉淀→lesson 记忆)
                └─→ R5 (桌面端 + evals)
```

## 5. 一致性约束（贯穿各期）

1. **确认语义只加强不放松**：code_edit/write/shell 全部 needsConfirm；无人值守走白名单+批准队列；工作区边界硬校验；
2. **零新增运行时依赖**：记忆/profile/编码工具全部 Node 内置 + 现有 4 依赖（chalk/commander/fast-glob/inquirer）实现；
3. **向后兼容**：aiConfig 旧字段自动迁移为 default profile；SessionRecord/HTTP API 结构只增不改；现有命令缺省行为不变；
4. **记忆是辅助不是真理**：注入段明示「与当前事实冲突时以现场为准」，避免过期记忆误导。

## 6. 兼容性假设

- 3000 字符为记忆**注入预算**上限（存储可更多，注入时按权重裁剪）；
- 模型接入仅支持 OpenAI 兼容协议（覆盖智谱/DeepSeek/Moonshot/Kimi/Ollama 等主流端点）；
- 编码工具确认语义与现有工具一致：交互模式逐次确认（'always' 可会话授权），无人值守拒绝。
