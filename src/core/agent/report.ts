import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCommand } from '../exec';
import { TodoItem, renderTodos } from './todo';
import { AgentStats } from './sessionStore';

/**
 * Harness 快照与终局报告（H3）。
 * - snapshotGit：执行前记录 workDir 的 git HEAD 与已改动文件（用于报告与回滚建议）；
 * - writeReport：终局把结构化报告落盘 ~/.sejuani/agent-sessions/<id>.report.md；
 * - rollbackHint：给出安全的回滚建议命令（不自动执行破坏性 git 操作）。
 */

const REPORTS_DIR = path.join(os.homedir(), '.sejuani', 'agent-sessions');

export interface GitSnapshot {
  isRepo: boolean;
  head?: string;
  /** 快照时已改动（未提交）文件 */
  dirtyFiles: string[];
}

function git(workDir: string, args: string[]): { ok: boolean; out: string } {
  const r = runCommand('git', args, { cwd: workDir });
  return { ok: r.ok, out: `${r.stdout}`.trim() };
}

/** 执行前快照：记录 HEAD 与已改动文件 */
export function snapshotGit(workDir: string): GitSnapshot {
  try {
    const inside = git(workDir, ['rev-parse', '--is-inside-work-tree']);
    if (!inside.ok || inside.out !== 'true') return { isRepo: false, dirtyFiles: [] };
    const head = git(workDir, ['rev-parse', 'HEAD']);
    const status = git(workDir, ['status', '--porcelain']);
    const dirtyFiles = status.out
      ? status.out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean)
      : [];
    return { isRepo: true, head: head.ok ? head.out : undefined, dirtyFiles };
  } catch {
    return { isRepo: false, dirtyFiles: [] };
  }
}

/** 相对快照后新增/变更的文件（供报告展示） */
export function changedSince(workDir: string, snap: GitSnapshot): string[] {
  if (!snap.isRepo) return [];
  const status = git(workDir, ['status', '--porcelain']);
  const now = status.out ? status.out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean) : [];
  const before = new Set(snap.dirtyFiles);
  return now.filter((f) => !before.has(f));
}

/**
 * 回滚建议（安全）：仅返回命令文本，不自动执行破坏性 git 操作。
 * 让用户自行决定是否回滚 harness 期间的改动。
 */
export function rollbackHint(snap: GitSnapshot, changed: string[]): string {
  if (!snap.isRepo || changed.length === 0) return '';
  return [
    '如需回滚本次改动（请自行确认后执行）：',
    `  git checkout -- ${changed.map((f) => `'${f}'`).join(' ')}`,
    snap.head ? `  # 或整体回到快照提交：git reset --hard ${snap.head}（会丢弃改动）` : '',
  ].filter(Boolean).join('\n');
}

export interface ReportInput {
  goal: string;
  outcome: string;
  iterations: number;
  todos: TodoItem[];
  summary: string;
  usage: AgentStats;
  workDir?: string;
  snapshot?: GitSnapshot;
  changed?: string[];
}

/** 终局结构化报告落盘，返回文件路径 */
export function writeReport(sessionId: string, input: ReportInput): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const file = path.join(REPORTS_DIR, `${sessionId}.report.md`);
  const totalTokens = input.usage.promptTokens + input.usage.completionTokens;
  const lines = [
    `# Harness 执行报告 · ${sessionId}`,
    '',
    `- 目标：${input.goal}`,
    `- 终局：**${input.outcome}**`,
    `- 迭代：${input.iterations} 轮 · 工具调用 ${input.usage.toolCalls} 次 · tokens ${totalTokens}`,
    `- 时间：${new Date().toISOString()}`,
    '',
    '## 任务清单',
    renderTodos(input.todos),
    '',
    '## 总结',
    input.summary || '(无)',
  ];
  if (input.changed && input.changed.length > 0) {
    lines.push('', '## 改动文件', ...input.changed.map((f) => `- ${f}`));
    const hint = rollbackHint(input.snapshot ?? { isRepo: false, dirtyFiles: [] }, input.changed);
    if (hint) lines.push('', '## 回滚建议', '```', hint, '```');
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** 报告目录（提示用） */
export function reportsDir(): string {
  return REPORTS_DIR;
}
