# Sejuani · Skills × 工作流 可组合体系设计蓝图

> 状态：设计定稿（未实施） · 范围：`src/core/workflow/` + `src/core/agent/`
> 核心诉求：强大的工作流编排 + skills 管理 + **二者可自由组合、相互嵌套**
> 约束：零新增运行时依赖；复用现有 workflow 引擎（17 StepKind/触发/表达式/流程控制）与模板机制。

---

## 0. 现状与目标

### 0.1 现状
- **工作流**：引擎成熟——DAG 拓扑、5 类触发器、`{{表达式}}`、when/foreach/wait/onFailure、agent.task、执行历史、批准队列。
- **skills**：仅以 `workflow/templates.ts` 命名模板形态存在（可存骨架、按组件重绑定、免 AI 套用），**不是一等实体**，也**无法被工作流步骤调用**。
- **缺口**：skill 与 workflow 是两套割裂的东西，不能组合——不能"工作流第 3 步执行某 skill"，也不能"把一个工作流存成 skill 供别处引用"。

### 0.2 目标：三者可组合
```
Skill（可复用单元）──被引用──▶ Workflow（步骤编排）
   ▲                              │
   └──────可固化为───────────────┘
Workflow 步骤可调用 Skill；Skill 可由 Workflow 固化而来；两者皆可被 Agent/触发器驱动
```

---

## 1. Skill 提为一等实体

### 1.1 数据模型（新建 core/skill/types.ts）
```ts
export interface Skill {
  name: string;                 // 唯一标识（kebab-case）
  title: string;
  description: string;          // 适用场景（供 Agent 判断何时用）
  triggers?: string[];          // 触发词/关键词（Agent 语义匹配）
  kind: 'workflow' | 'prompt';  // workflow=确定性步骤编排；prompt=自然语言操作指南
  /** kind=workflow：内嵌 workflow 步骤骨架（复用现有 WorkflowStep） */
  steps?: WorkflowStep[];
  /** kind=prompt：给 LLM 的操作指南正文（LLM 读了照做） */
  guide?: string;
  /** 关联：云效单号 / 其它 skill 名（组合与追溯） */
  links?: { requirements?: string[]; skills?: string[] };
  savedAt: string;
}
```
- 存储：`~/.sejuani/skills/<name>/skill.json`（+ 可选 `SKILL.md` 人类可读版，与 openclaw/Hermes 目录式技能对齐）。
- 两种 kind 并存：`workflow` 型交引擎确定性执行；`prompt` 型注入上下文交 LLM 执行。二者互补不替代。

### 1.2 管理面
- CLI：`sjn skill list | show <name> | rm <name> | run <name>`（run：workflow 型直接执行，prompt 型进 agent 会话套用）。
- Agent 工具组 `skill`（capabilities/skill.ts）：`skill_list`/`skill_get`/`skill_run`/`skill_save`。
- **skill_save = skill-creator 内嵌**：把"刚完成的一段流程/对话"总结为 skill（workflow 型抽步骤，prompt 型抽指南），needsConfirm 后落盘。这即用户要的"直接总结 skills"。

---

## 2. 组合机制（本蓝图核心）

### 2.1 Workflow 步骤调用 Skill —— 新 StepKind `skill.invoke`
```ts
// steps/skill.ts
// params: { name: string; params?: Record<string,any> }
```
- `workflow` 型 skill：把其 steps 内联展开为子步骤执行（类似 flow.foreach 的子步骤机制），产物聚合回 `outputs`。
- `prompt` 型 skill：转为一次 `agent.task`（guide 作为 goal 前缀），受同样的白名单/预算约束。
- 深度守卫：skill 内不可再 `skill.invoke` 同名 skill（防循环，复用子代理 depth 思路）。

### 2.2 Workflow 固化为 Skill —— 复用 U3 闭环
- `sjn flow save-skill <workflowId> <skillName>` 或 Agent `skill_save`：把已保存/已跑通的 workflow spec 转 `kind:'workflow'` 的 skill（去运行态字段，保步骤骨架）。
- 与现有 `templates.ts` 关系：templates 归并为 skill 的 workflow 型子集（迁移：现有模板首次读取时映射为 skill，向后兼容）。

### 2.3 Skill 引用 Skill —— links.skills
- skill 步骤中用 `skill.invoke` 调其它 skill，形成可组合的技能网络；`links.skills` 记录依赖供追溯与展示。

### 2.4 组合的三种入口
| 入口 | 组合形态 |
|---|---|
| Agent 会话 | LLM 按 description/triggers 选 skill → `skill_run`；或规划 workflow 时插入 `skill.invoke` 步骤 |
| 工作流 spec | 手写/AI 规划的 workflow 里直接放 `skill.invoke` 步骤，与 git/yunxiao/code 步骤自由编排 |
| 触发器 | W1 触发器触发的 workflow 内含 skill.invoke → 无人值守自动跑组合流程 |

---

## 3. 与 Notion（U5）打通（可选后续）
- skill/workflow 落盘同时，经 Notion MCP 记入「技能库/工作流库」，需求单号关联——形成"查得到、复用得上、追溯得清"的团队中枢。
- 本蓝图不依赖 Notion；Notion 是 skill 的团队级镜像与检索层。

---

## 4. 涉及文件
| 文件 | 改动 |
|---|---|
| `core/skill/types.ts` `core/skill/store.ts` | 新建：Skill 模型 + 存取（skill.json / SKILL.md） |
| `core/workflow/steps/skill.ts` | 新建：`skill.invoke` StepKind（内联展开/转 agent.task/深度守卫） |
| `core/workflow/steps/index.ts` `types.ts` | 注册 skill.invoke + StepKind 扩充 |
| `core/agent/capabilities/skill.ts` | 新建：skill_list/get/run/save 工具（含 skill-creator 固化逻辑） |
| `core/workflow/templates.ts` | 迁移：模板映射为 workflow 型 skill（向后兼容） |
| `cli/commands/skill.ts` | 新建：`sjn skill` 命令族 |
| `core/agent/brain.ts` | system prompt 注入「可用 skills」清单 + "先查 skill 再造"引导 |

## 5. 分期
```
K1 Skill 一等实体（types/store + CLI + skill 工具组 + skill-creator 固化）── 地基
 └─ K2 组合机制（skill.invoke StepKind + workflow 固化为 skill + 模板迁移）── 核心
     └─ K3 触发器/Notion 打通（无人值守组合流程 + 团队库镜像）── 收口
```

## 6. 一致性约束
- 零新增依赖：skill 存取/组合全 Node 内置，复用 workflow 引擎与 agent harness。
- 确认语义零放松：skill_save/skill.invoke 危险步骤沿用现有确认/批准/无人值守拒绝。
- 向后兼容：现有 workflow 模板迁移为 skill，不丢失；workflow spec 结构只增 skill.invoke 一种 kind。
- 防循环：skill.invoke 深度守卫，复用子代理 MAX_DEPTH 思路。
