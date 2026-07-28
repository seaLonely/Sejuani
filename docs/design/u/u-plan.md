# U 系列实施计划总纲 · Agent 能力对标增强

> 状态：文档阶段（不改代码） · 来源蓝图：docs/design/agent-uplift.md（U1-U5）
> 本目录：把 U 系列从蓝图细化为环节级可执行文档（docs/design/u/*.md）
> 约束：零新增运行时依赖；复用现有 brain/harness/memory/sessionStore/workflow/hooks；确认语义零放松；向后兼容。

---

## 0. 范围与重叠处理

对标 NousResearch/hermes-agent 与 openclaw/openclaw（均 MIT，仅借鉴设计模式，不拷贝源码），提炼契合「前端工程编码智能体」的能力，剔除语音/25+ 渠道/VPS 常驻等与定位不符项。

| 编号 | 主题 | 状态 | 备注 |
|---|---|---|---|
| U1 | 项目上下文文件 + 交互命令 | 待实施 | 零依赖、每轮受益，优先 |
| U2 | 会话搜索 + 用户画像 | 待实施 | 纯 JS，不引 SQLite |
| **U3** | 技能自创建闭环 | **已并入 K1.4** | 本目录不重复，见 docs/design/k1/k1.4-skill-creator.md |
| U4 | 渠道接入（飞书/企业微信） | 待实施 | 复用 W1 hooks；合规红线：不做个人微信 |
| U5 | Notion 流程中枢 | 待实施（前置阻塞） | 依赖用户提供 Notion MCP（mcps/ 下暂无） |

---

## 1. 环节文档清单

| 环节 | 文档 | 依赖 | 可否即刻实施 |
|---|---|---|---|
| U1 | `u/u1-context-commands.md` | 无 | ✅ 可 |
| U2 | `u/u2-session-search-profile.md` | 无 | ✅ 可 |
| U4 | `u/u4-channels.md` | W1 hooks（已有） | ⚠️ 需先确认飞书/企微应用凭证 |
| U5 | `u/u5-notion-hub.md` | Notion MCP（未就绪） | ❌ 阻塞，等 MCP |

> U3 不在本目录（并入 K1.4）。

---

## 2. 每份文档统一结构

目标与范围 / 数据结构与接口 / 文件级改动清单 / 逐步实现要点 / 安全一致性 / 验收标准与冒烟点 / 风险与回滚。达到"照着写代码"粒度。

---

## 3. 建议实施顺序（与 K 主线协调）

```
K1（skill 一等实体，进行中主线）
  → U1（上下文文件+交互命令，零依赖顺手补基础）
  → K2（skill×工作流组合）
  → U2（会话搜索+画像）
  → U4（飞书，待凭证）
  → U5 + K3（等 Notion MCP，一起做团队库打通）
```
理由：U1 是"基础 agent 能力"最后一块拼图（AGENTS.md 读取），成本最低、每轮受益，应尽早；U5/K3 共享 Notion 依赖，合并推进省一次集成。

---

## 4. 文档编写进度

- [x] 本总纲
- [x] u1-context-commands
- [x] u2-session-search-profile
- [x] u4-channels
- [x] u5-notion-hub

> 文档全部完成，进入待实施状态；U3 已在 K1.4。实施顺序见 §3。
