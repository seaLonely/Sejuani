# Sejuani Agent 能力对标增强蓝图（U1-U5）

> 状态：设计定稿（未实施） · 范围：`src/core/agent/` + `mcps/` 集成
> 来源：对标 NousResearch/hermes-agent 与 openclaw/openclaw（均 MIT，仅借鉴设计模式，不拷贝源码）
> 定位裁剪：只取契合「前端工程编码智能体」的模式，剔除语音/多渠道生态/VPS 常驻等与定位不符的臃肿
> 约束：零新增运行时依赖（Notion 走 MCP，不引 SDK）；复用现有 brain/harness/memory/sessionStore/workflow。

---

## 0. 对标提炼（真实 README，非营销页）

| Hermes/OpenClaw 模式 | 瑟庄妮现状 | 采纳 |
|---|---|---|
| 项目上下文文件（AGENTS.md/SOUL.md 注入每轮） | 无 | U1 采纳 |
| 交互命令 /new /compact /retry /undo /think | 仅 /clear /stats | U1 采纳 |
| 会话搜索（FTS5 + LLM 摘要跨会话召回） | sessionStore 不可检索 | U2 采纳（纯 JS 关键词，不引 SQLite） |
| 用户画像（USER.md 建模"你是谁"） | memory.preference 雏形 | U2 采纳（memory 加 profile 类） |
| 技能自创建闭环（完成任务→固化 skill→复用改进） | workflow 模板 + memory.lesson，缺自动固化 | U3 采纳（打通现有模板） |
| 子代理并行 | 已做 agent_dispatch | 已对齐 |
| cron 无人值守 | 已做 W1 触发器 | 已对齐 |
| 多渠道（飞书/企业微信…） | W1 已有 /api/hooks | U4 采纳（仅飞书/企业微信，合规前提） |
| 语音/25+ 渠道/VPS 常驻管理 | — | 不采纳（与定位不符） |
| **文档化流程中枢（Notion）** | 无 | **U5 采纳（本轮新增，用户核心诉求）** |

--

## 0.5 基础能力基线核查（用户定义的「最基础 agent 能力」）

实施增强前先确认地基。以下为代码实测结论：

| 基础能力 | 现状 | 位置 | 缺口 |
|---|---|---|---|
| 连接模型 API | ✅ 已有 | aiClient.ts + state/aiConfig.ts（多 profile/4 角色） | 无 |
| 上下文/记忆 | ✅ 已有 | agent/memory.ts（3000 字符注入） | 无 |
| 使用 skills | ⚠️ 以 workflow 模板形态存在 | workflow/templates.ts（命名保存/复用/重绑定） | 无独立 SKILL.md 概念，见下注 |
| 批量处理能力 | ✅ 已有 | repos 工具组(5) + 批量 CLI（replace-url/set-version/sync/release/upgrade） | 无 |
| 读取 AGENTS.md / init.md | ❌ 未实现 | — | **U1 补齐（下方细化）** |

> **skill 与 workflow 模板的关系（澄清）**：瑟庄妮没有独立 `SKILL.md` 文件体系，但 `workflow/templates.ts` 的命名模板即"可复用技能"的实现——存骨架、按当前选中组件重绑定、免 AI 直接套用。U3 的"技能自创建"就是在此之上补"自动固化"。若确需 openclaw/Hermes 那种 `SKILL.md` 目录式技能，可作为 U1 扩展项（见 1.3）。

---

## 1. U1：项目上下文文件 + 交互命令

### 1.1 上下文文件（区别于个人记忆——这是随仓库走的团队约定）
- 启动 Agent 时，自 cwd 向上逐级查找并按固定优先级读取项目上下文文件，全部命中内容按顺序拼接注入 system prompt「项目上下文」段（总预算 ≤4000 字符，超出截断并提示）：
  | 文件 | 语义 | 优先级 |
  |---|---|---|
  | `SEJUANI.md` | 瑟庄妮专属项目约定（最高） | 1 |
  | `AGENTS.md` | 通用 agent 约定（业界共识文件名，与 openclaw/Hermes 对齐） | 2 |
  | `init.md` | 项目初始化/背景说明 | 3 |
- 查找规则：从 cwd 向上到 git 仓库根（或 home）逐级找，每个文件取**最近一层**命中即停；三个文件独立查找、可同时存在。
- 生成辅助：新增 `sjn agent init` 命令，交互式在当前目录生成 `SEJUANI.md` 模板（技术栈/命名规范/构建命令/禁忌骨架），降低团队上手成本。
- 与记忆(S2)区别：记忆是跨会话个人偏好（本地 ~/.sejuani）；上下文文件是**随代码仓库走的项目约定**（进 git、团队共享）。
- 涉及：`core/agent/projectContext.ts`（新建：向上查找+多文件读取+预算截断）、`brain.ts`（buildSystemPrompt 注入「项目上下文」段，位置在能力说明之后、长期记忆之前）、`cli/commands/agent.ts`（`init` 子命令）。

### 1.2 交互命令（REPL）
| 命令 | 行为 | 复用 |
|---|---|---|
| `/new` `/reset` | 清空历史开新会话 | 复用 clearHistory |
| `/compact` | 立即触发历史 LLM 压缩 | 复用 compressHistoryIfNeeded |
| `/retry` | 重发上一条 user 消息 | 记录 lastUserInput |
| `/undo` | 撤销上一轮（弹出最近 user+assistant） | history 尾部裁剪 |
| `/think <low\|mid\|high>` | 提示词追加思考强度指令 | system 附加段 |

### 1.3 （可选扩展）SKILL.md 目录式技能
- 若需对齐 openclaw/Hermes 的 `~/.sejuani/skills/<name>/SKILL.md` 目录式技能（含 frontmatter + 步骤说明 + 触发词），可在 U1 追加：`core/agent/skills.ts` 扫描技能目录 → 注入 system prompt「可用技能」清单 → `/<skill-name>` 或工具触发套用。
- 与 workflow 模板并存：SKILL.md 适合"自然语言操作指南"（LLM 读了照做），workflow 模板适合"确定性步骤编排"（引擎执行）。二者可互补，不替代。
- 判断：非基础必需，视是否要与 agentskills.io/ClawHub 生态互通再定；缺省先用 workflow 模板承载技能。

---

## 2. U2：会话搜索 + 用户画像

- `session_search` 工具（readOnly）：扫描 `~/.sejuani/agent-sessions/*.json` 历史消息，**纯 JS 关键词/正则匹配**（不引 SQLite/FTS5/向量库，守零依赖底线），命中返回会话 id + 片段 + 时间；可选对命中会话调 LLM 摘要。
- 用户画像：memory 分类增加 `profile`（"你是谁/团队/常用域"），注入优先级高于 preference。
- 涉及：`capabilities/session.ts`（新建）、`memory.ts`（category 加 profile）。

---

## 3. U3：技能自创建闭环（Hermes 灵魂，打通现有能力）

- Harness 完成复杂任务（outcome=completed 且 toolCalls 达阈值）后，**建议**把本次流程固化：抽取执行序列 → 生成 workflow 模板草案 或 skill 描述 → 询问确认后存入模板库/记忆。
- 与现有打通：直接复用 `workflow/templates.ts`（已有模板存取）+ `memory.lesson`；U3 补的是"自动提炼 + 固化建议"这一环，非新建存储。
- 使用中改进：命中已有模板执行失败/被修正时，回写模板修订。
- 涉及：`harness.ts`（收尾钩子加"固化建议"）、`workflow/templates.ts`（草案生成）。

---

## 4. U4：渠道接入（仅飞书 / 企业微信，合规前提）

- **复用 W1 已有 `POST /api/hooks/:path`**：飞书/企业微信事件订阅 → webhook → 触发工作流或 agent.task 巡检。
- 出站通知：新增 `notify.channel` 步骤或 `channel_send` 工具，把工单变更/巡检结果/审批推送到群。
- **合规红线（写死）**：只支持飞书开放平台 + 企业微信应用/群机器人（官方 API）；**不做个人微信号自动化**（违反使用协议、封号风险）。
- 涉及：`server/routes/hooks.ts`（飞书事件校验签名）、`core/channel/`（新建，飞书/企微客户端，走 fetch 零依赖）。

---

## 5. U5：文档化流程中枢（Notion MCP）⭐ 本轮新增

### 5.1 目标
把 Notion 做成瑟庄妮的**团队流程知识库**：日常重复操作流程化后记录，形成"需求 ↔ 流程 ↔ 技能"的可查可复用可追溯网络。瑟庄妮通过用户提供的 **Notion MCP** 读写，无需自建存储。

### 5.2 Notion 库结构（建议 4 个关联数据库）
| 数据库 | 关键字段 | 用途 |
|---|---|---|
| **需求（Requirements）** | 云效单号、标题、内容、状态、关联流程/技能 | 需求台账，单号为主键 |
| **技能（Skills）** | 名称、描述、适用场景、步骤、关联需求 | 可复用操作沉淀 |
| **工作流（Workflows）** | 名称、触发器、步骤编排(JSON)、关联需求/技能 | 对应瑟庄妮 workflow spec |
| **执行记录（Runs）** | 时间、关联需求/工作流、结果、报告链接 | 追溯，对接 Harness 终局报告 |

关联：需求 ←→ 技能 ←→ 工作流 三向 relation；执行记录挂到需求+工作流。

### 5.3 MCP 集成方式（关键设计）
- **不引 Notion SDK**：瑟庄妮通过 MCP 协议调用用户配置的 Notion MCP server（`mcps/` 下），核心零依赖不破。
- 新增 Agent 工具组 `notion`（capabilities/notion.ts），工具是 **MCP 调用的薄封装**：
  | 工具 | 作用 |
  |---|---|
  | `notion_find_requirement` | 按云效单号/关键词查需求页 |
  | `notion_upsert_requirement` | 建/更新需求页（单号+内容+状态） |
  | `notion_save_skill` | 把一个技能/流程记录进技能库 |
  | `notion_save_workflow` | 把 workflow spec 记录进工作流库（JSON 存 code block） |
  | `notion_log_run` | 记执行记录（关联需求+结果+报告） |
  | `notion_search` | 跨库检索（复用需求前先查有无现成流程） |
- **MCP 客户端**：`core/mcp/client.ts`（新建，读 `mcps/<server>/tools/*.json` schema，按现有 CallMcpTool 约定发起调用），notion 工具经它转发。
- **配置**：`sjn config` / state.json 加 `notion.mcpServer`（MCP server 名）+ 4 个数据库 id。

### 5.4 工作闭环（U5 与 U3/云效串起来）
```
接到需求 → notion_find_requirement(单号) 查有无现成流程
  ├─ 命中 → 套用关联 workflow/skill 直接执行
  └─ 未命中 → 正常处理 → 完成后 U3 固化建议 →
       notion_upsert_requirement + notion_save_workflow + notion_log_run 记回
下次同类需求 → 一查即得，越用越顺
```

### 5.5 涉及文件
`core/mcp/client.ts`（新建 MCP 转发）、`core/agent/capabilities/notion.ts`（新建 6 工具）、`core/agent/registry.ts`（注册）、`core/state/`（notion 配置）、`cli/commands`（notion 配置命令）、brain system prompt（引导"先查 Notion 流程库"）。

---

## 6. 分期建议与依赖

```
U1 上下文文件+交互命令（最低成本，每轮受益）── 独立可先行
U2 会话搜索+用户画像 ── 独立
U3 技能自创建闭环 ── 依赖 workflow 模板（已有）
U5 Notion 流程中枢 ── 依赖 MCP 客户端；与 U3 固化闭环、云效单号打通后价值最大
U4 渠道接入（飞书/企微）── 依赖 W1 hooks（已有），合规前提
```

推荐顺序：U1 → U5（用户核心诉求）→ U3（与 U5 固化闭环互补）→ U2 → U4。

## 7. 一致性约束
- 零新增运行时依赖：上下文文件/会话搜索/画像全 Node 内置；Notion 走 MCP 不引 SDK。
- 确认语义零放松：notion 写工具（upsert/save/log）默认 needsConfirm（避免误写团队库）；只读查询工具并行。
- 合规红线：渠道仅飞书/企业微信官方 API，不做个人微信自动化。
- 上下文文件与记忆分层：文件=项目约定（进 git、团队共享），记忆=个人偏好（本地 ~/.sejuani）。

## 8. 待用户确认项（实施前）
- Notion MCP server 的名称与可用工具（届时读 `mcps/<name>/tools/*.json` 确认真实 schema，不臆测参数）。
- 4 个数据库的 id 与字段命名（或由瑟庄妮首次运行时按上述结构建库）。
- 渠道优先级：飞书 or 企业微信先做（个人微信不做）。
