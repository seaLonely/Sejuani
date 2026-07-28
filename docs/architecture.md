# Sejuani（瑟庄妮）· 项目架构与功能体系

> 面向前端工程/组件批量治理的终端工具，已演进为具备记忆、多模型、自主编码能力的编码智能体。
> 版本基线：v1.4.0 之后（R1-R5：多模型 + 记忆 + Harness + 编码闭环 + 桌面端已落地）。
> 技术约束：零第三方 UI 库；仅 4 个运行时依赖（chalk / commander / fast-glob / inquirer）；Node 20+。

---

## 1. 总览：三层部署 × 七层能力

```
部署形态（三层）                          能力分层（七层，自底向上）
┌─ Tauri 桌面壳   app/ (7 页面)           ⑦ 模型层  多 profile + 4 场景角色绑定
├─ 本地 HTTP API  src/server/ (8 路由组)  ⑥ 记忆层  3000 字符注入 · 域隔离 · 三分类
└─ CLI 内核       src/core/ (43 命令+REPL) ⑤ 能力层  9 组 42 工具
   ↑ CLI 与桌面端共享同一内核              ④ 大脑    brain 多轮工具循环
                                          ③ 执行壳  Harness 自主循环
                                          ② 编排层  workflow 引擎 17 StepKind
                                          ① 交互层  CLI / REPL / 桌面 / SSE
```

设计原则：CLI 内核是唯一业务层，桌面端与 HTTP API 均复用之；核心零 UI/交互依赖，确认与输入通过回调注入（inquirer 或 SSE 桥）。

---

## 2. 六大功能域（业务视角）

### 2.1 批量工程 / 组件治理（立身之本）
`src/core/` 平铺约 20 个模块，经 CLI 暴露：
- 批量编辑：`replace-url`（yarn.lock resolved URL）、`set-version`、`set-name`
- 发布链路：`sync`（pack→publish）、`release`（构建后发包）、`upgrade`（按 catalog 精确升级）
- 依赖治理：`catalog`、`deps-tree`（组件间依赖拓扑分层）、`who-uses` / `project-deps` / `usage`（用量三视角）、`check-deps`、`registries`
- 空间管理：`domain`（chery/foton/saas 域切换）、`vs`（虚拟空间圈选）、`link`（软链聚合）、`alias`（命令短链）

### 2.2 云效（Yunxiao）业务集成
`issue`（工单查询）、`task`（交互看板：查看/流转/评论）、`fix <issueId>`（AI 修缺陷 → 提交 MR 的完整 fix-bug 流），配套 yunxiao 工具组。

### 2.3 AI Agent 智能体（M1-M4）
`sjn agent` / `chat` REPL：多轮 Function Calling、流式输出、三态确认（yes/no/always）+ 会话级授权、历史 LLM 压缩、会话持久化 + 脱敏审计、token/耗时统计。
REPL 命令：`/model` `/memory` `/todos` `/goal` `/tools` `/stats` `/clear` `/help` `/exit`。

### 2.4 工作流编排引擎（W1-W4，n8n 对标）
- 触发调度：5 类触发器（manual / interval / cron / 云效工单轮询 / webhook）+ 常驻调度器（手写 cron、水位去重、并发闸、热重载、崩溃恢复）；`sjn serve` 即宿主，`sjn flow watch` 为纯调度前台。
- 数据流：`{{steps.x.outputs.y}}` 受限点路径表达式（不做任意 JS）+ 六态执行历史独立存档。
- 流程控制：17 种 StepKind，含 `when` 条件 / skipped 级联 / `flow.foreach` / `flow.wait`（延时·webhook·人工确认三模式）/ `onFailure` 收尾链。
- AI 巡检：`agent.task`（`harness:true` 时跑到目标达成）+ 内置模板 + **waiting-approval 批准队列**。

### 2.5 Harness 自主执行壳（H1-H4）
`AgentHarness.runGoal`：目标 → 拆 todo → 迭代（预算闸 → 熔断闸 → brain.process → todo 完成度判定）→ **H2 验证回路**（失败回喂自修复）→ **H3 git 快照 + 终局报告落盘**（回滚仅建议）→ **H4 经验沉淀写 lesson 记忆**。五种终局（completed / budget-exhausted / stalled / aborted / max-iterations）皆产出总结。
入口：`sjn agent --goal` / REPL `/goal` / `agent.task harness:true` / `POST /api/agent/goal`（SSE 进度）。

### 2.6 编码能力（S3，混合委托路线）
内建 6 个 `code_*` 工具（工作区 realpath 边界硬校验、唯一匹配编辑）+ 外部 `coder` 委托 claude/codex。
自主编码闭环：`sjn agent --goal "..."` → 拆 todo → 定位（search/read）→ 编辑（edit/write）→ 跑构建测试（shell）→ 失败自修复 → 终局报告 + 经验沉淀。选择准则：中小改动内建自主，>5 文件/长时推理/用户点名则委托外部。

---

## 3. 九组 Agent 工具（42 个）

| 组 | 数量 | 工具 |
|---|---|---|
| repos | 5 | discover / catalog / who_uses / deps_tree / project_deps |
| yunxiao | 7 | list_tasks / view_task / transition / comment / list_sprints / list_members / set_defaults |
| workflow | 6 | list / show / templates / plan / run / resume |
| taskFlow | 4 | start_dev / submit_review / complete / fix_bug |
| env | 5 | check / switch_node / install_node / detect_pm / install_deps |
| coder | 4 | fix / ask / set_tool / status |
| memory | 3 | write / read / forget |
| todo | 2 | write / read |
| code | 6 | tree / read / search / edit / write / shell |

只读工具（查询类）在同批 tool_calls 中并行执行；写类/危险工具 needsConfirm。

---

## 4. 横切系统

### 4.1 模型层（S1）
OpenAI 兼容多 profile（智谱/DeepSeek/Moonshot/Ollama 等）；`chat / planner / compress / agentTask` 四场景各绑不同模型，未绑定回退 activeProfile；旧扁平配置自动迁移为 `default` profile。
CLI：`ai-config profile add|use|rm|list` / `ai-config role set <角色> <profile>`；REPL：`/model`。

### 4.2 记忆层（S2）
存储 `~/.sejuani/memory/<domain>.json`，按域隔离，preference/project/lesson 三分类，权重排序，注入 system prompt 时受 3000 字符预算裁剪。写入路径：`memory_write` 工具 / LLM 主动沉淀 / Harness H4 lesson。

### 4.3 安全体系（贯穿）
三态确认 + 会话级授权 → 无人值守白名单 + 批准队列 → 编码工作区 realpath 边界（含符号链接祖先回溯）→ 预算闸 + 防循环熔断 → 脱敏审计（apiKey/token 打码）→ 危险步骤绝不静默执行。

### 4.4 存储基座
统一 `~/.sejuani/`：`state.json`（域/别名/虚拟空间/AI/云效/coder 配置）、`workflows/`（spec + 执行历史 + 触发水位）、`agent-sessions/`（会话 + 审计 + 报告）、`memory/`（长期记忆）。

---

## 5. 桌面端页面（app/，7 页）

| 页面 | 功能 |
|---|---|
| Chat | Agent 对话 + 自主目标模式（Harness）+ 工具调用气泡 + SSE 流式 |
| 任务看板 | 云效工单看板 |
| 工作流 | spec 列表/执行/日志 + **待批准队列** |
| 记忆与模型 | 长期记忆管理 + 多 profile 切换 + 角色绑定 |
| 批量操作 | 批量编辑入口 |
| 依赖看板 | 依赖分析可视化 |
| 设置 | 域/AI/云效配置 |

技术栈：Tauri v2 + React 18 + Tailwind v3 + Shadcn/ui，冰霜蓝白主题；后端 SSE 实时推送（delta/harness-progress/confirm 等）。

---

## 6. 设计蓝图索引（docs/design/）

| 文档 | 范围 | 状态 |
|---|---|---|
| `agent-workflow-enhancement.md` | M1-M4：Agent 内直跑/引擎强化/交互/可观测性 | 已实施 |
| `workflow-orchestration.md` | W1-W4：n8n 对标编排层 | 已实施 |
| `agent-harness.md` | H1-H4：Harness 执行壳 | H1-H4 已实施 |
| `sejuani-master-plan.md` | S1-S3 + 七层架构 + R1-R5 路线图 | 已实施 |

---

## 7. 后续优化路径（P0 已清，P1-P3 待排）

- P1 工程质量：将累计的冒烟断言沉淀为常驻回归测试集（`npm test`）；review 遗留 #7（写端点 Origin 校验）、#8（跨进程并发锁）、#9（危险确认展示渲染后参数）、cron 日/周 AND 语义文档化。
- P2 能力深化：记忆时间衰减 + 每域容量上限；evals 用例扩充 + 结果落盘跨版本对比；桌面端逐字流式渲染。
- P3 产品化收口：更新 `sjn guide` / README 覆盖新命令；token 成本折算可视化；发布 v1.5.0。
