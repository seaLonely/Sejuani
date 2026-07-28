import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 项目上下文文件（U1）：从 cwd 向上逐级查找随仓库走的项目约定文件，注入 system prompt。
 * 与记忆区别：这是团队共享、进 git 的项目约定（技术栈/命名/禁忌/构建命令）。
 * 查找文件与优先级：SEJUANI.md(1) > AGENTS.md(2) > init.md(3)。
 */

/** 上下文文件名及优先级（数组顺序即拼接顺序） */
const CONTEXT_FILES = ['SEJUANI.md', 'AGENTS.md', 'init.md'];
/** 注入 system prompt 的总字符预算 */
export const CONTEXT_BUDGET = 4000;

export interface ProjectContextFile {
  file: string;
  path: string;
  content: string;
}

/** 从 startDir 向上到 git 仓库根/home/fs 根，为每个文件名取最近一层命中 */
export function loadProjectContext(startDir: string): ProjectContextFile[] {
  const found = new Map<string, ProjectContextFile>();
  const home = os.homedir();
  let dir = path.resolve(startDir);
  const seenRoot = () => fs.existsSync(path.join(dir, '.git'));

  // 逐级向上；命中的文件名不再向上覆盖（就近优先）
  for (;;) {
    for (const name of CONTEXT_FILES) {
      if (found.has(name)) continue;
      const p = path.join(dir, name);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          found.set(name, { file: name, path: p, content: fs.readFileSync(p, 'utf8') });
        }
      } catch {
        /* 读取失败跳过 */
      }
    }
    if (seenRoot()) break; // 到 git 仓库根为止
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) break; // 触底
    dir = parent;
  }

  // 按 CONTEXT_FILES 优先级排序返回
  return CONTEXT_FILES.filter((n) => found.has(n)).map((n) => found.get(n)!);
}

/** 渲染注入 system prompt 的「项目上下文」段（≤CONTEXT_BUDGET，超出截断）；无则空串 */
export function renderProjectContext(startDir: string): string {
  const files = loadProjectContext(startDir);
  if (files.length === 0) return '';
  const header = '【项目上下文】以下为随仓库的项目约定（团队共享，优先遵守；与当前对话事实冲突时以现场为准）：';
  const parts: string[] = [header];
  let used = header.length;
  for (const f of files) {
    const block = `\n--- ${f.file} ---\n${f.content.trim()}`;
    if (used + block.length > CONTEXT_BUDGET) {
      const remain = CONTEXT_BUDGET - used;
      if (remain > 100) parts.push(block.slice(0, remain) + '\n（已截断）');
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('');
}

/** SEJUANI.md 模板（sjn agent init 生成） */
export const SEJUANI_MD_TEMPLATE = `# 项目约定（SEJUANI.md）

> 本文件随仓库走、团队共享，会被 Sejuani Agent 每次对话读取并注入上下文。

## 技术栈
- 语言/框架：
- 包管理器：
- Node 版本：

## 命名规范
-

## 构建与验证命令
- 构建：
- 测试：
- Lint：

## 禁忌与注意
-

## 关键路径
-
`;
