import { chalk } from './logger';

/**
 * 零依赖 Markdown → ANSI 终端渲染（REPL 展示 LLM 回复用）。
 * 支持：标题/加粗/斜体/行内代码/代码块/表格(CJK 对齐)/列表/引用/分隔线/链接。
 * 纯文本输入原样透传（仅转换命中的 md 语法）。
 */

/** 显示宽度：去 ANSI 后 CJK/全角按 2 计（表格对齐用） */
function strWidth(s: string): number {
  const clean = s.replace(/\u001b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function padCell(s: string, width: number): string {
  const pad = width - strWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 行内语法：`code` **bold** *italic* ~~del~~ [text](url) */
function inline(text: string): string {
  let t = text;
  // 行内代码先抽出保护，避免内部被再次格式化
  const codes: string[] = [];
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, s: string) => chalk.bold(s));
  t = t.replace(/__([^_]+)__/g, (_m, s: string) => chalk.bold(s));
  t = t.replace(/~~([^~]+)~~/g, (_m, s: string) => chalk.dim.strikethrough(s));
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, (_m, pre: string, s: string) => pre + chalk.italic(s));
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt: string, url: string) => chalk.cyan(txt) + chalk.dim(`(${url})`));
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => chalk.cyan(codes[Number(i)]));
  return t;
}

/** 是否表格分隔行（|---|:--:|） */
function isTableSeparator(line: string): boolean {
  const l = line.trim();
  return /^[|:\-\s]+$/.test(l) && l.includes('-') && l.includes('|');
}

function parseRow(l: string): string[] {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/** 把 Markdown 文本渲染为带 ANSI 样式的终端文本 */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```lang ... ```
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim();
      const block: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      i++; // 跳过闭合 ```
      out.push(chalk.dim(`┌─${lang ? ` ${lang} ` : ''}${'─'.repeat(4)}`));
      for (const b of block) out.push(chalk.dim('│ ') + b);
      out.push(chalk.dim('└' + '─'.repeat(6)));
      continue;
    }

    // 表格：当前行含 | 且下一行是分隔行
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseRow(line).map(inline);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseRow(lines[i]).map(inline));
        i++;
      }
      const widths = header.map((h, c) => Math.max(strWidth(h), ...rows.map((r) => strWidth(r[c] ?? ''))));
      out.push('  ' + header.map((h, c) => chalk.bold(padCell(h, widths[c]))).join('  '));
      out.push('  ' + chalk.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
      for (const r of rows) out.push('  ' + widths.map((w, c) => padCell(r[c] ?? '', w)).join('  '));
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = inline(h[2]);
      out.push(h[1].length <= 2 ? chalk.bold.cyan(text) : chalk.bold(text));
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(chalk.dim('─'.repeat(30)));
      i++;
      continue;
    }

    // 引用
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      out.push(chalk.dim('│ ') + chalk.dim(inline(q[1])));
      i++;
      continue;
    }

    // 无序/有序列表
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      out.push(ul[1] + chalk.cyan('•') + ' ' + inline(ul[2]));
      i++;
      continue;
    }
    const ol = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (ol) {
      out.push(ol[1] + chalk.cyan(ol[2] + '.') + ' ' + inline(ol[3]));
      i++;
      continue;
    }

    out.push(inline(line));
    i++;
  }
  return out.join('\n');
}
