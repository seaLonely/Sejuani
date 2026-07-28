import fs from 'fs';
import os from 'os';
import path from 'path';
import { Skill } from './types';

/**
 * Skill 持久化（K1.1）：~/.sejuani/skills/<name>/ 下
 *   skill.json  结构化真源（读写以此为准）
 *   SKILL.md    人类可读镜像（save 时同步生成，仅供人看，不作读取源）
 */
const SKILLS_DIR = path.join(os.homedir(), '.sejuani', 'skills');

/** 名称合法校验（防路径穿越） */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

function skillDir(name: string): string {
  return path.join(SKILLS_DIR, name);
}

/** 生成 SKILL.md 人类可读镜像 */
function renderSkillMd(skill: Skill): string {
  const lines: string[] = [
    `# ${skill.title || skill.name}`,
    '',
    `- name: ${skill.name}`,
    `- kind: ${skill.kind}`,
    `- description: ${skill.description || ''}`,
  ];
  if (skill.triggers && skill.triggers.length) lines.push(`- triggers: ${skill.triggers.join(', ')}`);
  lines.push('');
  if (skill.kind === 'workflow') {
    lines.push('## 步骤');
    (skill.steps ?? []).forEach((s, i) => {
      const danger = s.dangerous ? ' [不可逆]' : '';
      lines.push(`${i + 1}. ${s.title} (${s.kind})${danger}`);
    });
  } else {
    lines.push('## 操作指南', '', skill.guide ?? '');
  }
  return lines.join('\n') + '\n';
}

/** 保存/覆盖技能：校验 → 写 skill.json → 生成 SKILL.md。返回目录路径 */
export function saveSkill(skill: Skill): string {
  if (!isValidSkillName(skill.name)) {
    throw new Error(`技能名非法：${skill.name}（仅允许字母/数字/._-）`);
  }
  if (skill.kind === 'workflow' && (!skill.steps || skill.steps.length === 0)) {
    throw new Error('workflow 型技能必须包含非空 steps');
  }
  if (skill.kind === 'prompt' && (!skill.guide || !skill.guide.trim())) {
    throw new Error('prompt 型技能必须包含非空 guide');
  }
  const normalized: Skill = {
    ...skill,
    title: skill.title || skill.name,
    description: skill.description || '',
    savedAt: skill.savedAt || new Date().toISOString(),
  };
  const dir = skillDir(skill.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(normalized, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), renderSkillMd(normalized));
  return dir;
}

/** 读取技能；不存在返回 null */
export function loadSkill(name: string): Skill | null {
  if (!isValidSkillName(name)) return null;
  try {
    const file = path.join(skillDir(name), 'skill.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Skill;
  } catch {
    return null;
  }
}

/** 列出全部技能（按 savedAt 倒序） */
export function listSkills(): Skill[] {
  try {
    if (!fs.existsSync(SKILLS_DIR)) return [];
    const skills: Skill[] = [];
    for (const name of fs.readdirSync(SKILLS_DIR)) {
      const s = loadSkill(name);
      if (s) skills.push(s);
    }
    return skills.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
  } catch {
    return [];
  }
}

/** 删除技能（整目录）；成功 true */
export function removeSkill(name: string): boolean {
  if (!isValidSkillName(name)) return false;
  try {
    const dir = skillDir(name);
    if (!fs.existsSync(dir)) return false;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** 技能根目录（提示用） */
export function skillsDir(): string {
  return SKILLS_DIR;
}

/** 校验并解析技能内部引用文件的绝对路径（限技能目录内，防穿越）；非法返回 null */
function resolveSkillFile(name: string, relPath: string): string | null {
  if (!isValidSkillName(name)) return null;
  const base = skillDir(name);
  const target = path.resolve(base, relPath);
  const rel = path.relative(base, target);
  // rel 不能以 .. 开头也不能是绝对路径（否则越出技能目录）；也不允许直接命中 skill.json
  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === 'skill.json') return null;
  return target;
}

/** 列出技能目录下的引用文件（递归，相对路径，排除 skill.json/SKILL.md） */
export function listSkillFiles(name: string): string[] {
  if (!isValidSkillName(name)) return [];
  const base = skillDir(name);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(base, abs);
      if (e.isDirectory()) walk(abs);
      else if (rel !== 'skill.json' && rel !== 'SKILL.md') out.push(rel);
    }
  };
  try { walk(base); } catch { /* ignore */ }
  return out;
}

/** 读取技能引用文件（渐进式披露 L2）；不存在/非法返回 null */
export function readSkillFile(name: string, relPath: string): string | null {
  const target = resolveSkillFile(name, relPath);
  if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  try { return fs.readFileSync(target, 'utf8'); } catch { return null; }
}

/** 写入/更新技能引用文件（限技能目录内）；成功返回绝对路径，非法抛错 */
export function writeSkillFile(name: string, relPath: string, content: string): string {
  const target = resolveSkillFile(name, relPath);
  if (!target) throw new Error(`非法的技能引用文件路径：${relPath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
