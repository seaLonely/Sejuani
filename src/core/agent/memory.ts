import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 长期记忆系统（S2）：按域隔离的跨会话记忆，注入 system prompt 时受 3000 字符预算约束。
 * 存储 ~/.sejuani/memory/<domain>.json（存储无上限，注入时按权重裁剪）。
 * 分类：profile 用户画像（你是谁/团队/常用域，优先级最高） / preference 用户偏好 / project 项目事实 / lesson 经验教训（H4 沉淀写入此类）。
 * 零依赖，JSON 单文件简单可靠。
 */

export type MemoryCategory = 'profile' | 'preference' | 'project' | 'lesson';

export interface MemoryEntry {
  id: string;
  category: MemoryCategory;
  /** 单条内容，写入时截断至 200 字符 */
  content: string;
  /** 注入排序权重：被引用/更新 +1 */
  weight: number;
  updatedAt: string;
}

/** 注入 system prompt 的字符预算上限 */
export const MEMORY_BUDGET = 3000;
/** 单条内容字符上限 */
const CONTENT_MAX = 200;

const MEMORY_DIR = path.join(os.homedir(), '.sejuani', 'memory');

/** 类别注入优先级（数字越小越优先） */
const CATEGORY_ORDER: Record<MemoryCategory, number> = { profile: 0, preference: 1, project: 2, lesson: 3 };

function memoryFile(domain: string): string {
  const safe = /^[a-zA-Z0-9._-]+$/.test(domain) ? domain : 'default';
  return path.join(MEMORY_DIR, `${safe}.json`);
}

function readAll(domain: string): MemoryEntry[] {
  try {
    const file = memoryFile(domain);
    if (!fs.existsSync(file)) return [];
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? (arr as MemoryEntry[]) : [];
  } catch {
    return [];
  }
}

function writeAll(domain: string, entries: MemoryEntry[]): void {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(memoryFile(domain), JSON.stringify(entries, null, 2) + '\n');
}

function genId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 排序：类别优先级 → weight 降序 → updatedAt 降序 */
function sortEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return [...entries].sort((a, b) => {
    const c = CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category];
    if (c !== 0) return c;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '');
  });
}

/** 列出某域全部记忆（已排序） */
export function listMemory(domain: string): MemoryEntry[] {
  return sortEntries(readAll(domain));
}

/**
 * 新增/更新记忆：提供 id 且存在则更新（weight+1），否则新增。
 * 同域同类内容完全相同的条目会被合并（weight+1）而非重复插入。
 */
export function upsertMemory(
  domain: string,
  entry: { id?: string; category?: MemoryCategory; content: string }
): MemoryEntry {
  const entries = readAll(domain);
  const content = entry.content.trim().slice(0, CONTENT_MAX);
  const now = new Date().toISOString();

  if (entry.id) {
    const found = entries.find((e) => e.id === entry.id);
    if (found) {
      found.content = content;
      if (entry.category) found.category = entry.category;
      found.weight += 1;
      found.updatedAt = now;
      writeAll(domain, entries);
      return found;
    }
  }
  // 内容去重合并
  const dup = entries.find((e) => e.content === content);
  if (dup) {
    dup.weight += 1;
    dup.updatedAt = now;
    if (entry.category) dup.category = entry.category;
    writeAll(domain, entries);
    return dup;
  }
  const created: MemoryEntry = {
    id: genId(),
    category: entry.category ?? 'preference',
    content,
    weight: 1,
    updatedAt: now,
  };
  entries.push(created);
  writeAll(domain, entries);
  return created;
}

/** 删除一条记忆；成功返回 true */
export function forgetMemory(domain: string, id: string): boolean {
  const entries = readAll(domain);
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return false;
  writeAll(domain, next);
  return true;
}

/**
 * 渲染注入 system prompt 的「长期记忆」段：按排序拼接，累计字符超 MEMORY_BUDGET 时截断
 * （淘汰低优先/低权重条目，不删存储）。无记忆返回空串。
 */
export function renderMemory(domain: string): string {
  const entries = sortEntries(readAll(domain));
  if (entries.length === 0) return '';
  const header =
    '【长期记忆】以下为跨会话积累的记忆，供参考；与当前对话事实冲突时以现场为准：\n';
  const labelOf: Record<MemoryCategory, string> = {
    profile: '画像',
    preference: '偏好',
    project: '项目',
    lesson: '教训',
  };
  const lines: string[] = [];
  let used = header.length;
  for (const e of entries) {
    const line = `- [${labelOf[e.category]}] ${e.content}`;
    if (used + line.length + 1 > MEMORY_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (lines.length === 0) return '';
  return header + lines.join('\n');
}

/** 记忆目录路径（提示用） */
export function memoryDir(): string {
  return MEMORY_DIR;
}
