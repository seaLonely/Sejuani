# U5 · Notion 流程中枢（MCP 集成）

> 环节：U5 · 状态：**已实现并端到端验证**（真实子进程 MCP server 冒烟通过）
> 目标：把 Notion 做成团队流程知识库——需求单号 ↔ 技能 ↔ 工作流 ↔ 执行记录，瑟庄妮经 Notion MCP 读写。
> 与 K3 关系：U5 提供 Notion 读写能力；K3 用它把 skill/workflow 镜像到团队库。

---

## 0. 实现方式（关键修正）

原设想「读 Qoder 的 `mcps/<name>/tools/*.json`」不成立——那是 Qoder 编辑器环境的 MCP，**Sejuani 运行时（用户装包后）无法访问**。正确做法：**Sejuani 自带 MCP 客户端**，让用户配置自己的 Notion MCP 服务器。

- 用**标准 MCP 协议**（JSON-RPC 2.0 over stdio，换行分隔）自行实现客户端 `core/mcp/client.ts`（零依赖 child_process）。
- 工具在**运行时经 `tools/list` 发现**（`notion_status` 可查真实工具名与 inputSchema），**不臆测任何 Notion 专属 schema**。
- 用户经 `sjn mcp add notion npx -y @notionhq/notion-mcp-server`（示例）配置服务器，`sjn notion set-server/set-db` 绑定团队库。
- 已实现：`McpSession`（initialize/tools.list/tools.call/close）、`mcp_list_tools`/`mcp_call`、`notion_status`/`notion_call`（db id 占位符替换）、`sjn mcp`/`sjn notion` CLI、brain 第 12 条引导。
- 待用户提供真实 Notion MCP + token + database id 后，即可实盘联调（协议层已用 mock server 端到端验证）。

---

## 1. 目标与范围

- 新建 MCP 客户端转发层 + `notion` Agent 工具组（6 工具），把需求/技能/工作流/执行记录写入 Notion。
- 工作闭环：接需求先查 Notion 有无现成流程 → 命中套用 / 未命中处理后记回。
- **不含**：Notion 之外的文档系统；本环节不改 skill/workflow 核心（K3 负责镜像逻辑）。

---

## 2. Notion 库结构（4 个关联数据库）

| 数据库 | 关键字段 | 主键 |
|---|---|---|
| 需求 Requirements | 云效单号、标题、内容、状态、关联技能/工作流 | 云效单号 |
| 技能 Skills | 名称、描述、kind、步骤/指南、关联需求 | 名称 |
| 工作流 Workflows | 名称、触发器、步骤编排(JSON code block)、关联需求/技能 | 名称 |
| 执行记录 Runs | 时间、关联需求/工作流、结果、报告链接 | 自动 |

关联：需求 ←→ 技能 ←→ 工作流 三向 relation；Runs 挂需求+工作流。可由瑟庄妮首次运行按此结构建库（若 MCP 支持建库），或用户手建后提供 database id。

---

## 3. MCP 客户端（新建 `src/core/mcp/client.ts`）

- 读 `mcps/<server>/SERVER_METADATA.json` 与 `tools/*.json` 获取可用工具 schema。
- 提供 `callMcpTool(server, tool, args)`：按已确认 schema 转发调用（遵循环境的 MCP 调用约定）。
- **强约束**：调用前必须已读过该工具 schema（不猜参数名/类型）——与全局 MCP 使用规则一致。
- 零依赖：走环境提供的 MCP 通道，不引 Notion SDK。

---

## 4. notion 工具组（新建 `capabilities/notion.ts`，MCP 薄封装）

| 工具 | readOnly | needsConfirm | 作用 |
|---|---|---|---|
| `notion_search` | ✅ | — | 跨库检索（复用需求前先查现成流程） |
| `notion_find_requirement` | ✅ | — | 按云效单号/关键词查需求页 |
| `notion_upsert_requirement` | ❌ | ✅ | 建/更新需求页 |
| `notion_save_skill` | ❌ | ✅ | 技能记入技能库（关联需求） |
| `notion_save_workflow` | ❌ | ✅ | 工作流 spec 记入工作流库（JSON code block） |
| `notion_log_run` | ❌ | ✅ | 记执行记录（关联需求+结果+报告链接） |

- 写工具全部 needsConfirm（避免误写团队库）；均经 MCP client 转发。
- 具体参数以实际 Notion MCP 的 schema 为准（实施时读 tools/*.json 对齐）。

---

## 5. 配置（改 state + CLI）

- state.json 增 `notion`：`{ mcpServer: string; db: { requirements?, skills?, workflows?, runs? } }`（database id）。
- CLI：`sjn notion-config set-server <name>` / `set-db <key> <id>` / `show`。

---

## 6. 工作闭环（与云效 + K1/K3 串联）

```
接到需求(云效单号) → notion_find_requirement(单号)
  ├─ 命中且有关联 workflow/skill → skill_run / flow run 直接执行
  └─ 未命中 → 正常处理 → 完成后：
       notion_upsert_requirement(单号+内容+状态)
       + notion_save_skill / notion_save_workflow（K1 固化产物镜像）
       + notion_log_run(结果+Harness 报告链接)
下次同类需求 → notion_search 一查即得
```

---

## 7. 文件级改动清单（实施时，待 MCP 就绪）

| 文件 | 动作 |
|---|---|
| `src/core/mcp/client.ts` | 新建：MCP schema 读取 + callMcpTool 转发 |
| `src/core/agent/capabilities/notion.ts` | 新建：6 工具（MCP 薄封装） |
| `src/core/agent/registry.ts` | 改：注册 notionCapability |
| `src/core/state/` + `cli/commands/` | 改：notion 配置存取 + `notion-config` 命令 |
| `src/core/agent/brain.ts` | 改：system prompt 引导"先查 Notion 流程库" |

---

## 8. 安全一致性

- notion 写工具全部 needsConfirm；无人值守走白名单授权（默认不含写类）。
- MCP 调用前必须已读工具 schema（不臆测参数）。
- 单号/内容可能含业务敏感信息：仅在用户授权的 Notion 空间内读写，不外发第三方。
- 零依赖：不引 @notionhq/client，全走 MCP。

---

## 9. 验收标准与冒烟点（待 MCP 就绪后）

1. mcp/client 能读 `mcps/<notion>/tools/*.json` 并列出工具；
2. `notion_search`/`notion_find_requirement` 只读查询返回结果；
3. `notion_upsert_requirement` needsConfirm；确认后写入、可在 Notion 看到；
4. `notion_save_workflow` 把 spec JSON 存入 code block；
5. 闭环冒烟：查(未命中)→处理→记回→再查(命中)；
6. 配置脱敏；无配置时清晰引导；
7. tsc 0 错误。

---

## 10. 风险与回滚

- 风险：Notion MCP 实际 schema 与假设不符 → 缓解：实施第一步就读真实 schema 对齐，工具封装按实际参数写。
- 风险：MCP 不可用时 agent 报错打断 → 缓解：notion 工具失败返回结构化错误，不抛异常中断会话。
- 回滚：删 mcp/client.ts + notion.ts；registry 去注册；state 的 notion 为增量。
