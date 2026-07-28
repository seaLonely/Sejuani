import fs from 'fs';
import path from 'path';
import { Skill } from './types';

/**
 * 技能可移植格式（生态互通）：与 agentskills.io / Hermes 的 SKILL.md 约定互通。
 * - parseSkillMd：解析外部 SKILL.md（YAML frontmatter 子集 + markdown 正文）→ prompt 型 Skill；
 * - toSkillMd：把 Skill 序列化为标准 SKILL.md（含 name/description/version frontmatter），供导出共享。
 * 零依赖：手写极简 frontmatter 解析（仅取 name/description/version/tags 标量与简单数组）。
 */

/** 从 SKILL.md 文本解析出 frontmatter 字段与正文 */
function splitFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  // 归一化：去 BOM + CRLF→LF（兼容 Windows/下载件）
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!m) return { fm, body: normalized.trim() };
  const block = m[1];
  const body = m[2].trim();
  // 仅解析顶层 `key: value` 标量（忽略嵌套 metadata 树，取需要的字段）
  for (const line of block.split('\n')) {
    const mm = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line);
    if (mm) fm[mm[1]] = mm[2].trim();
  }
  return { fm, body };
}

/** 解析 SKILL.md 文本为 prompt 型 Skill（外部知识型技能统一落为 prompt 型） */
export function parseSkillMd(text: string, fallbackName?: string): Skill {
  const { fm, body } = splitFrontmatter(text);
  const name = (fm.name || fallbackName || '').trim();
  if (!name) throw new Error('SKILL.md 缺少 name（frontmatter 或文件目录名）');
  const tags = fm.tags
    ? fm.tags.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  return {
    name,
    title: fm.title || name,
    description: fm.description || '',
    triggers: tags,
    kind: 'prompt',
    guide: body,
    savedAt: new Date().toISOString(),
  };
}

/** 从磁盘读取一个 SKILL.md 文件或含 SKILL.md 的目录 */
export function readSkillMdFrom(target: string): Skill {
  const stat = fs.statSync(target);
  const file = stat.isDirectory() ? path.join(target, 'SKILL.md') : target;
  if (!fs.existsSync(file)) throw new Error(`未找到 SKILL.md：${file}`);
  const fallbackName = stat.isDirectory() ? path.basename(target) : undefined;
  return parseSkillMd(fs.readFileSync(file, 'utf8'), fallbackName);
}

/** 把 Skill 序列化为标准 SKILL.md（agentskills.io 兼容 frontmatter） */
export function toSkillMd(skill: Skill): string {
  const lines: string[] = ['---', `name: ${skill.name}`, `description: ${skill.description || ''}`, 'version: 1.0.0'];
  if (skill.triggers && skill.triggers.length) lines.push(`tags: [${skill.triggers.join(', ')}]`);
  lines.push('---', '', `# ${skill.title || skill.name}`, '');
  if (skill.kind === 'workflow') {
    lines.push('## Procedure');
    (skill.steps ?? []).forEach((s, i) => lines.push(`${i + 1}. ${s.title} (${s.kind})${s.dangerous ? ' [dangerous]' : ''}`));
  } else {
    lines.push(skill.guide ?? '');
  }
  return lines.join('\n') + '\n';
}
