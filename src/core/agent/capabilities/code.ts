import fs from 'fs';
import path from 'path';
import fg from 'fast-glob';
import { Capability, AgentTool, ToolResult } from '../types';
import { runCommand } from '../../exec';

/**
 * 内建编码工具集（S3，混合委托路线）：让瑟庄妮自主读写代码。
 * 安全基线：全部工具强制 workDir 参数并做 realpath 边界校验（拒绝越界/穿越/符号链接逃逸）；
 * 写类工具（edit/write/shell）needsConfirm，shell 额外视为危险；无人值守下走白名单+批准队列。
 */

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/target/**', '**/.next/**'];
const READ_MAX_LINES = 2000;
/** fg 通用选项：关闭符号链接跟随，避免只读工具顺链读出边界外内容 */
const FG_OPTS = { ignore: IGNORE, onlyFiles: true, followSymbolicLinks: false } as const;

/** 解析并校验路径在 workDir 边界内；越界抛错。返回 { workReal, targetAbs }。 */
function resolveInWorkDir(workDir: string, rel: string): { workReal: string; targetAbs: string } {
  if (!workDir || !workDir.trim()) throw new Error('缺少 workDir 参数');
  const workAbs = path.resolve(workDir);
  if (!fs.existsSync(workAbs) || !fs.statSync(workAbs).isDirectory()) {
    throw new Error(`workDir 不是有效目录: ${workDir}`);
  }
  const workReal = fs.realpathSync(workAbs);
  const targetAbs = path.resolve(workReal, rel ?? '.');
  // 防符号链接逃逸：回溯到最近的已存在祖先做 realpath（不能仅看直接父目录，
  // 因为多层不存在的路径下任意祖先可能是指向外部的符号链接），再拼回剩余段。
  let probe = targetAbs;
  const rest: string[] = [];
  while (!fs.existsSync(probe)) {
    rest.unshift(path.basename(probe));
    const parent = path.dirname(probe);
    if (parent === probe) break; // 触底根
    probe = parent;
  }
  const checkPath = fs.existsSync(probe) ? path.join(fs.realpathSync(probe), ...rest) : targetAbs;
  const prefix = workReal.endsWith(path.sep) ? workReal : workReal + path.sep;
  if (checkPath !== workReal && !checkPath.startsWith(prefix)) {
    throw new Error(`路径越出工作区边界: ${rel}（workDir=${workDir}）`);
  }
  return { workReal, targetAbs: checkPath };
}

const codeTree: AgentTool = {
  name: 'code_tree',
  readOnly: true,
  description: '列出工作目录的文件结构概览（忽略 node_modules/dist/.git 等）。用于快速了解项目布局。',
  parameters: {
    type: 'object',
    properties: {
      workDir: { type: 'string', description: '工作目录（绝对或相对路径）' },
      pattern: { type: 'string', description: "可选 glob（默认 '**/*'）" },
      limit: { type: 'number', description: '最多返回文件数，默认 200' },
    },
    required: ['workDir'],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const { workReal } = resolveInWorkDir(String(args.workDir), '.');
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 200;
      const entries = fg.sync(args.pattern ? String(args.pattern) : '**/*', {
        cwd: workReal,
        ...FG_OPTS,
        deep: 6,
        dot: false,
      }).slice(0, limit);
      return { success: true, output: `${workReal}（${entries.length} 文件）：\n${entries.join('\n')}` };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

const codeRead: AgentTool = {
  name: 'code_read',
  readOnly: true,
  description: '读取文件内容（可选行范围）。大文件按 READ_MAX_LINES 截断。',
  parameters: {
    type: 'object',
    properties: {
      workDir: { type: 'string', description: '工作目录' },
      file: { type: 'string', description: '相对 workDir 的文件路径' },
      startLine: { type: 'number', description: '起始行（1 起，可选）' },
      endLine: { type: 'number', description: '结束行（含，可选）' },
    },
    required: ['workDir', 'file'],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const { targetAbs } = resolveInWorkDir(String(args.workDir), String(args.file));
      if (!fs.existsSync(targetAbs)) return { success: false, output: `文件不存在: ${args.file}` };
      const all = fs.readFileSync(targetAbs, 'utf8').split('\n');
      const start = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
      const end = typeof args.endLine === 'number' ? Math.min(all.length, args.endLine) : Math.min(all.length, start + READ_MAX_LINES - 1);
      const slice = all.slice(start - 1, end);
      const numbered = slice.map((l, i) => `${start + i}\t${l}`).join('\n');
      const trunc = end < all.length ? `\n…（共 ${all.length} 行，已显示 ${start}-${end}）` : '';
      return { success: true, output: numbered + trunc };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

const codeSearch: AgentTool = {
  name: 'code_search',
  readOnly: true,
  description: '在工作目录内按正则检索文件内容（带行号），或按 glob 查找文件名。',
  parameters: {
    type: 'object',
    properties: {
      workDir: { type: 'string', description: '工作目录' },
      regex: { type: 'string', description: '内容检索正则（与 glob 二选一）' },
      glob: { type: 'string', description: '文件名 glob（与 regex 二选一）' },
      max: { type: 'number', description: '最多命中数，默认 50' },
    },
    required: ['workDir'],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const { workReal } = resolveInWorkDir(String(args.workDir), '.');
      const max = typeof args.max === 'number' && args.max > 0 ? args.max : 50;
      if (args.glob) {
        const files = fg.sync(String(args.glob), { cwd: workReal, ...FG_OPTS, deep: 8 }).slice(0, max);
        return { success: true, output: files.length ? files.join('\n') : '（无匹配文件）' };
      }
      if (!args.regex) return { success: false, output: '需提供 regex 或 glob 之一' };
      let re: RegExp;
      try {
        re = new RegExp(String(args.regex));
      } catch {
        return { success: false, output: `正则非法: ${args.regex}` };
      }
      const files = fg.sync('**/*', { cwd: workReal, ...FG_OPTS, deep: 8 });
      const hits: string[] = [];
      for (const rel of files) {
        if (hits.length >= max) break;
        let content: string;
        try {
          content = fs.readFileSync(path.join(workReal, rel), 'utf8');
        } catch {
          continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
      return { success: true, output: hits.length ? hits.join('\n') : '（无匹配）' };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

const codeEdit: AgentTool = {
  name: 'code_edit',
  needsConfirm: true,
  description: '精确文本替换：original 必须在文件内唯一匹配才执行（否则报歧义，需提供更多上下文）。',
  parameters: {
    type: 'object',
    properties: {
      workDir: { type: 'string', description: '工作目录' },
      file: { type: 'string', description: '相对 workDir 的文件路径' },
      original: { type: 'string', description: '要替换的原文（需在文件内唯一）' },
      replacement: { type: 'string', description: '替换后的新文本' },
    },
    required: ['workDir', 'file', 'original', 'replacement'],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const { targetAbs } = resolveInWorkDir(String(args.workDir), String(args.file));
      if (!fs.existsSync(targetAbs)) return { success: false, output: `文件不存在: ${args.file}` };
      const content = fs.readFileSync(targetAbs, 'utf8');
      const original = String(args.original);
      const idx = content.indexOf(original);
      if (idx < 0) return { success: false, output: '未找到 original 文本（请核对空白与缩进）' };
      if (content.indexOf(original, idx + 1) >= 0) {
        return { success: false, output: 'original 在文件内出现多次（歧义），请提供更多上下文使其唯一' };
      }
      fs.writeFileSync(targetAbs, content.replace(original, String(args.replacement)));
      return { success: true, output: `已编辑 ${args.file}` };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

const codeWrite: AgentTool = {
  name: 'code_write',
  needsConfirm: true,
  description: '创建或覆写文件（自动创建父目录）。覆写已存在文件时请谨慎。',
  parameters: {
    type: 'object',
    properties: {
      workDir: { type: 'string', description: '工作目录' },
      file: { type: 'string', description: '相对 workDir 的文件路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['workDir', 'file', 'content'],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const { targetAbs } = resolveInWorkDir(String(args.workDir), String(args.file));
      const existed = fs.existsSync(targetAbs);
      fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
      fs.writeFileSync(targetAbs, String(args.content));
      return { success: true, output: `${existed ? '已覆写' : '已创建'} ${args.file}` };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

const codeShell: AgentTool = {
  name: 'code_shell',
  needsConfirm: true,
  description: '在工作目录内执行命令（构建/测试/lint 等）。仅在 workDir 内运行。',
  parameters: {
    type: 'object',
    properties: {
      workDir: { type: 'string', description: '工作目录（命令的 cwd）' },
      command: { type: 'string', description: '可执行程序（如 npm/yarn/node）' },
      args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
    },
    required: ['workDir', 'command'],
  },
  async execute(args): Promise<ToolResult> {
    try {
      const { workReal } = resolveInWorkDir(String(args.workDir), '.');
      const cmd = String(args.command);
      const cmdArgs = Array.isArray(args.args) ? args.args.map(String) : [];
      const r = runCommand(cmd, cmdArgs, { cwd: workReal });
      const out = `${r.stdout}\n${r.stderr}`.trim().slice(-3000);
      return { success: r.ok, output: `[exit ${r.code}] ${out || '(无输出)'}` };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

export const codeCapability: Capability = {
  name: 'code',
  description: '内建编码：读写/检索代码、执行构建测试（工作区边界内；大改动可委托外部 coder）',
  tools: [codeTree, codeRead, codeSearch, codeEdit, codeWrite, codeShell],
};

/** 只读编码工具名（agent.task 缺省白名单可含这些） */
export const READONLY_CODE_TOOLS = ['code_tree', 'code_read', 'code_search'];
