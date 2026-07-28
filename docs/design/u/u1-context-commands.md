# U1 · 项目上下文文件 + 交互命令

> 环节：U1（无依赖，优先） · 状态：文档（不改代码）
> 目标：Agent 读取随仓库走的项目约定文件（SEJUANI.md/AGENTS.md/init.md）注入上下文；补齐成熟 agent 的交互命令。

---

## 1. 目标与范围

- 补齐"基础 agent 能力"最后一块：**读取 AGENTS.md/init.md 等项目上下文文件**。
- REPL 交互命令补齐：`/new` `/reset` `/compact` `/retry` `/undo` `/think`。
- 新增 `sjn agent init` 生成 `SEJUANI.md` 模板。
- **不含**：SKILL.md 目录式技能（K1 已覆盖技能形态）、渠道/Notion。

---

## 2. 项目上下文文件（新建 `src/core/agent/projectContext.ts`）

### 2.1 查找与读取
```ts
export interface ProjectContextFile { file: string; path: string; content: string }
/** 从 startDir 向上逐级查找，读取命中的上下文文件（各取最近一层） */
export function loadProjectContext(startDir: string): ProjectContextFile[];
/** 渲染注入 system prompt 的「项目上下文」段（总预算 ≤4000 字符，超出截断提示） */
export function renderProjectContext(startDir: string): string;
```
- 查找文件与优先级：`SEJUANI.md`(1) > `AGENTS.md`(2) > `init.md`(3)。
- 向上边界：到 git 仓库根（存在 `.git`）或用户 home 或文件系统根为止；每个文件名独立查找、取**最近一层**命中即停；三者可同时存在。
- 预算：三文件内容按优先级拼接，累计 ≤4000 字符，超出截断并标注 `（已截断）`。
- 纯 Node（fs/path），无依赖。

### 2.2 注入位置（改 `brain.ts` buildSystemPrompt）
- 在「可用能力模块」之后、「长期记忆」之前，插入「项目上下文」段：
  ```
  【项目上下文】以下为随仓库的项目约定（团队共享，优先遵守）：
  <renderProjectContext(cwd)>
  ```
- 与记忆分层：项目上下文=进 git 的团队约定；记忆=本地个人偏好。冲突时以当前对话事实为准（沿用记忆段声明风格）。

### 2.3 `sjn agent init`（改 `cli/commands/agent.ts`）
- 子命令：在 cwd 生成 `SEJUANI.md` 骨架（技术栈/命名规范/构建命令/禁忌/关键路径），已存在则提示不覆盖（除非 `--force`）。

---

## 3. 交互命令（改 `src/cli/repl.ts` handleCommand + 主循环）

| 命令 | 行为 | 复用 |
|---|---|---|
| `/new` `/reset` | 清空历史开新会话（保留 system） | 复用 brain.clearHistory |
| `/compact` | 立即触发历史 LLM 压缩 | 复用 brain 内 compressHistoryIfNeeded（需暴露 public 方法 compactNow） |
| `/retry` | 重发上一条 user 输入 | REPL 记 lastUserInput，重走 process |
| `/undo` | 撤销上一轮（弹出尾部 user+assistant/tool 组） | brain 新增 undoLastTurn() |
| `/think <low\|mid\|high>` | 设置思考强度，后续轮在 process 前追加 system 提示 | REPL 保存 thinkLevel，随 process 注入 |

- brain 需新增 public：`compactNow()`（调内部压缩）、`undoLastTurn()`（从 history 尾部移除最近一组非 system 消息）。
- `/help` 文案同步补充新命令。

---

## 4. 文件级改动清单

| 文件 | 动作 |
|---|---|
| `src/core/agent/projectContext.ts` | 新建：查找+读取+预算渲染 |
| `src/core/agent/brain.ts` | 改：buildSystemPrompt 注入「项目上下文」段；新增 compactNow/undoLastTurn public |
| `src/cli/repl.ts` | 改：/new /reset /compact /retry /undo /think + lastUserInput/thinkLevel 状态 + /help |
| `src/cli/commands/agent.ts` | 改：`agent init` 子命令生成 SEJUANI.md |

---

## 5. 安全一致性

- 上下文文件只读注入，不执行；预算硬截断防 prompt 膨胀。
- `/undo` 只裁剪本地 history，不触发外部操作；含 tool_calls 的组整组移除（保护 tool_calls 协议，不留悬挂）。
- `agent init` 不覆盖已存在文件（除非 --force）。

---

## 6. 验收标准与冒烟点

1. cwd 放 `AGENTS.md` → 启动 agent 后 system prompt 含其内容（可打印 buildSystemPrompt 断言）；
2. 三文件同时存在 → 按优先级拼接、SEJUANI 在前；
3. 超 4000 字符 → 截断并标注；
4. 向上查找：子目录启动能读到仓库根的 AGENTS.md；
5. `/new` 清空历史；`/compact` 触发压缩（历史变短）；`/undo` 移除最近一轮；`/retry` 重发上条；`/think high` 后续轮注入思考提示；
6. `sjn agent init` 生成 SEJUANI.md，重复执行不覆盖（--force 才覆盖）；
7. tsc 0 错误；现有对话/流式不回归。

---

## 7. 风险与回滚

- 风险：上下文文件过大挤占 token → 缓解：4000 预算 + 截断。
- 风险：/undo 破坏 tool_calls 配对 → 缓解：整组移除（assistant+其后所有 tool，再到 user）。
- 回滚：删 projectContext.ts；brain 去注入段与两个 public 方法；repl 去新命令。
