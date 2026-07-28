# K1 实施计划总纲 · Skill 一等实体 + skill-creator（并入 U3）

> 状态：文档阶段（不改代码） · 归属主线：Skills × 工作流可组合（docs/design/skills-workflow-compose.md 的 K1）
> 本轮交付：K1 总计划 + 每环节独立可执行文档（docs/design/k1/*.md）
> 约束：零新增运行时依赖；复用现有 workflow 引擎 / agent harness / templates；确认语义零放松；向后兼容。

---

## 0. K1 目标

把「技能（skill）」从 workflow 模板的附属形态，提升为**一等实体**，并内嵌 **skill-creator**（把已完成的流程/对话自动总结固化为 skill）。U3「技能自创建闭环」并入本期，由 skill-creator 的固化能力统一承载。

产出后可用：
- `sjn skill list/show/run/save/rm` 管理技能
- Agent 会话内 `skill_list/get/run/save` 工具（LLM 可查、可用、可固化技能）
- Harness 完成复杂任务后**建议固化为 skill**（U3 闭环）
- 两种技能形态：`workflow` 型（确定性步骤，交引擎执行）/ `prompt` 型（自然语言指南，交 LLM 执行）

**本期不含**（留给 K2）：`skill.invoke` StepKind、workflow 固化为 skill、skill 引用 skill、模板全面迁移。K1 只让 skill 独立成立并可被创建/使用。

---

## 1. 环节拆分与依赖

| 环节 | 名称 | 依赖 | 文档 |
|---|---|---|---|
| **K1.1** | Skill 数据模型与存储 | 无 | `k1/k1.1-model-store.md` |
| **K1.2** | skill 管理工具组（agent 侧） | K1.1 | `k1/k1.2-agent-tools.md` |
| **K1.3** | `sjn skill` CLI 命令族 | K1.1 | `k1/k1.3-cli.md` |
| **K1.4** | skill-creator 固化（含 U3 harness 收尾建议） | K1.1、K1.2 | `k1/k1.4-skill-creator.md` |
| **K1.5** | system prompt 接线 + 构建验证冒烟 | K1.1-K1.4 | `k1/k1.5-wiring-verify.md` |

依赖链：
```
K1.1 模型/存储（地基）
 ├─ K1.2 agent 工具组 ─┐
 ├─ K1.3 CLI          ─┼─→ K1.4 skill-creator ─→ K1.5 接线+验证
 └───────────────────┘
```

---

## 2. 关键设计决策（贯穿各环节）

1. **存储路径**：`~/.sejuani/skills/<name>/skill.json`（结构化）+ 可选 `SKILL.md`（人类可读镜像）。与 openclaw/Hermes 目录式技能对齐，但格式自定（不拷其代码）。
2. **两种 kind 并存**：`workflow` 型存 `WorkflowStep[]` 骨架；`prompt` 型存自然语言 `guide`。K1 只做存取与执行，不做组合（K2）。
3. **复用而非新造**：
   - `workflow` 型 skill 执行 = 复用 `runWorkflow`（buildStepContext + 引擎）；
   - `prompt` 型 skill 执行 = 复用 `AgentBrain`/`AgentHarness`（guide 作 goal 前缀）；
   - skill-creator 固化 = 复用 `workflow/templates.ts` 的骨架抽取思路 + `memory` 的 lesson 沉淀。
4. **U3 并入点**：Harness `runGoal` 收尾（outcome=completed 且 toolCalls 达阈值）时，emit 一个"建议固化"事件；交互模式提示用户 `skill_save`，无人值守仅记录不打断。
5. **确认语义**：`skill_save` needsConfirm（避免误写技能库）；`skill_run` 中若含危险步骤，沿用现有确认/批准/无人值守拒绝。
6. **向后兼容**：现有 `templates.ts` 不动（K2 再迁移）；K1 的 skill 与 template 暂并存，`skill list` 可选附带展示 templates 以便过渡。

---

## 3. 验收总标准（K1 完成的定义）

- `sjn skill save/list/show/run/rm` 全链路可用（workflow 型与 prompt 型各验证）；
- Agent 会话内可 `skill_list` 看到、`skill_run` 执行、`skill_save` 固化；
- Harness 完成任务后能给出固化建议（U3）；
- 前后端 `tsc` 零错误；冒烟覆盖：模型存取往返、workflow 型执行、prompt 型执行、skill_save 去运行态字段、确认语义、非法名拒绝；
- 零新增依赖；现有 workflow/模板功能不回归。

---

## 4. 文档编写进度

- [x] 本总纲
- [x] k1.1 模型与存储
- [x] k1.2 agent 工具组
- [x] k1.3 CLI
- [x] k1.4 skill-creator（含 U3）
- [x] k1.5 接线与验证

> 文档全部完成，进入待实施状态；实施顺序 = 环节编号顺序（K1.1→K1.5）。
