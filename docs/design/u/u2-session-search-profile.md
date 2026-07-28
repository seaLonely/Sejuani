# U2 · 会话搜索 + 用户画像

> 环节：U2（无依赖） · 状态：文档（不改代码）
> 目标：跨会话检索历史对话（召回过去结论），并把"你是谁/团队/常用域"建模为用户画像记忆。

---

## 1. 目标与范围

- `session_search` Agent 工具：跨会话全文关键词检索历史对话，命中返回会话 id + 片段 + 时间。
- 用户画像：memory 分类增加 `profile`（注入优先级最高），承载"你是谁/团队/常用域/长期约定"。
- **不含**：SQLite/FTS5/向量库（守零依赖）——用纯 JS 关键词/正则扫描。

---

## 2. 会话搜索（新建 `src/core/agent/capabilities/session.ts`）

### 2.1 存储现状复用
- 现有 `~/.sejuani/agent-sessions/<id>.json`（含 history、createdAt、updatedAt、stats）。U2 只读，不改存储结构。
- sessionStore 已有 `listSessions()`；U2 增补 `searchSessions()` 到 sessionStore 或 session.ts。

### 2.2 检索函数（sessionStore.ts 增补）
```ts
export interface SessionHit { id: string; updatedAt: string; snippets: string[] }
/** 关键词/正则扫描全部会话的 user/assistant 文本；返回命中会话与片段（按 updatedAt 倒序，限 N） */
export function searchSessions(query: string, opts?: { limit?: number; regex?: boolean }): SessionHit[];
```
- 遍历 sessions 目录，读各 `<id>.json`，对 history 中 role∈{user,assistant} 的 content 做匹配（默认大小写不敏感子串；regex=true 走正则）。
- 每会话最多取 3 条片段（命中行 ±上下文），整体限 `limit`（默认 10）。
- 当前活跃会话可排除（避免搜到自己本轮）。

### 2.3 工具
| 工具 | readOnly | 作用 |
|---|---|---|
| `session_search` | ✅ | 入参 `{ query, regex?, limit? }` → searchSessions → 返回命中列表文本 + data |
| `session_recall` | ✅ | 入参 `{ id }` → 读该会话 → 可选调 LLM（role:'compress'）摘要该会话，返回摘要 |

- `session_recall` 的 LLM 摘要为可选：默认返回原始片段拼接，参数 `summarize:true` 才调 LLM（控成本）。

---

## 3. 用户画像（改 `src/core/agent/memory.ts`）

- `MemoryCategory` 增加 `'profile'`；`CATEGORY_ORDER` 中 profile 优先级最高（0），preference 次之。
- 注入渲染：profile 段置于记忆最前，标签「画像」。
- 写入：`memory_write` category 枚举增加 profile；system prompt 引导"用户自我介绍/团队/长期身份信息 → 存 profile"。
- 兼容：现有 memory 数据无 profile 项，不受影响；渲染排序对旧数据稳定。

---

## 4. 注册与接线

- registry 注册 `sessionCapability`（session_search/session_recall）。工具总数 +2。
- memory.ts 的 category 扩展 + memory.ts capabilities 的 enum 同步（`memory_write` 描述与 enum 加 profile）。
- REPL 可选加 `/recall <关键词>`（薄封装 session_search，便捷人工检索）——非必需，视需要。

---

## 5. 文件级改动清单

| 文件 | 动作 |
|---|---|
| `src/core/agent/sessionStore.ts` | 增补：searchSessions + SessionHit |
| `src/core/agent/capabilities/session.ts` | 新建：session_search/session_recall 工具 |
| `src/core/agent/memory.ts` | 改：MemoryCategory 加 profile + 排序 + 渲染标签 |
| `src/core/agent/capabilities/memory.ts` | 改：memory_write category enum 加 profile |
| `src/core/agent/registry.ts` | 改：注册 sessionCapability |
| `src/cli/repl.ts` | （可选）/recall 命令 |

---

## 6. 安全一致性

- session_search/recall 只读，可并行；搜索范围限 `~/.sejuani/agent-sessions/`，不越界。
- 历史可能含敏感信息：搜索结果原样返回给同一用户的 LLM（本地场景），不外发；与现有审计脱敏边界一致（审计脱敏针对工具参数落盘，会话内容本就属该用户）。
- profile 写入 needsConfirm 与其它 memory_write 一致（纯本地状态，无需确认，沿用现状）。

---

## 7. 验收标准与冒烟点

1. 造 2 个含关键词的历史会话文件 → `searchSessions('关键词')` 命中 2 个、按 updatedAt 倒序；
2. regex 模式匹配；limit 生效；活跃会话排除；
3. `session_recall({id})` 返回片段；`summarize:true`（stub LLM）返回摘要；
4. memory 加 profile：upsertMemory(category:'profile') → renderMemory 中 profile 段在最前、标签「画像」；
5. 旧 memory 数据（无 profile）渲染不报错、排序稳定；
6. registry 含 session_search/recall（+2）；
7. tsc 0 错误；memory 既有能力不回归。

---

## 8. 风险与回滚

- 风险：会话多时全文扫描慢 → 缓解：限 limit + 只读 content + 可后续加倒排索引（K/U 之外优化，非本期）。
- 回滚：删 session.ts；sessionStore 去 searchSessions；memory 的 profile 为增量枚举，保留无害或回退。
