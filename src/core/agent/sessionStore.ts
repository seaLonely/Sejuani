import fs from 'fs';
import os from 'os';
import path from 'path';
import { ChatMessage } from '../aiClient';

/**
 * Agent 会话持久化：~/.sejuani/agent-sessions/
 *   <id>.json          会话记录（history/时间戳/统计）
 *   <id>.audit.jsonl   工具调用审计（每行一条，追加写）
 * 仅在会话携带 sessionId 时启用；临时会话不落盘。
 */

const SESSIONS_DIR = path.join(os.homedir(), '.sejuani', 'agent-sessions');

/** 会话累计统计（M4 可观测性） */
export interface AgentStats {
  /** LLM 轮次（每次 chatWithTools 调用计 1） */
  rounds: number;
  /** 工具调用总数 */
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: string;
}

export interface AgentSessionRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
  stats?: AgentStats;
  /** Harness 任务清单快照（H1，向后兼容） */
  todos?: import('./todo').TodoItem[];
}

/** 工具调用审计条目（argsDigest 已脱敏） */
export interface AuditEntry {
  ts: string;
  tool: string;
  argsDigest: string;
  success: boolean;
  durationMs: number;
  /** 确认结果：yes/always/granted（已授权跳过）/none（无需确认） */
  confirmed: string;
}

function sessionFile(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function auditFile(id: string): string {
  return path.join(SESSIONS_DIR, `${id}.audit.jsonl`);
}

/** 保存会话记录（覆盖写） */
export function saveSession(rec: AgentSessionRecord): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(sessionFile(rec.id), JSON.stringify(rec, null, 2) + '\n');
}

/** 读取会话记录；不存在或损坏返回 null */
export function loadSession(id: string): AgentSessionRecord | null {
  try {
    const file = sessionFile(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as AgentSessionRecord;
  } catch {
    return null;
  }
}

/** 列出全部已持久化会话（按更新时间倒序） */
export function listSessions(): Array<Pick<AgentSessionRecord, 'id' | 'createdAt' | 'updatedAt'>> {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const items: Array<Pick<AgentSessionRecord, 'id' | 'createdAt' | 'updatedAt'>> = [];
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.audit.jsonl')) continue;
      const rec = loadSession(path.basename(f, '.json'));
      if (rec) items.push({ id: rec.id, createdAt: rec.createdAt, updatedAt: rec.updatedAt });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

/** 敏感参数键名黑名单（脱敏时整体替换值） */
const SECRET_KEYS = /key|token|secret|password|credential/i;

/**
 * 生成脱敏参数摘要：仅键名与截断值；命中敏感键名的值替换为 ***。
 * 绝不落 apiKey/token 类明文。
 */
export function digestArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_KEYS.test(k)) {
      parts.push(`${k}=***`);
      continue;
    }
    const text = Array.isArray(v) ? v.map(String).join(',') : String(v ?? '');
    parts.push(`${k}=${text.slice(0, 60)}`);
  }
  return parts.join(' ');
}

/** 追加一条工具调用审计（无 sessionId 的临时会话不落盘） */
export function appendAudit(sessionId: string, entry: AuditEntry): void {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    fs.appendFileSync(auditFile(sessionId), JSON.stringify(entry) + '\n');
  } catch {
    /* 审计失败不影响主流程 */
  }
}

/** 会话目录路径（用于提示） */
export function sessionsDir(): string {
  return SESSIONS_DIR;
}

export interface SessionHit {
  id: string;
  updatedAt: string;
  snippets: string[];
}

/**
 * 跨会话搜索（U2）：纯 JS 关键词/正则扫描全部会话的 user/assistant 文本，
 * 返回命中会话与片段（按 updatedAt 倒序，限 limit）。不引 SQLite/向量库，守零依赖。
 */
export function searchSessions(
  query: string,
  opts: { limit?: number; regex?: boolean; excludeId?: string } = {}
): SessionHit[] {
  const q = (query ?? '').trim();
  if (!q) return [];
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 10;
  let matcher: (text: string) => boolean;
  try {
    if (opts.regex) {
      const re = new RegExp(q, 'i');
      matcher = (t) => re.test(t);
    } else {
      const lower = q.toLowerCase();
      matcher = (t) => t.toLowerCase().includes(lower);
    }
  } catch {
    const lower = q.toLowerCase();
    matcher = (t) => t.toLowerCase().includes(lower);
  }
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const hits: SessionHit[] = [];
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.audit.jsonl')) continue;
      const id = path.basename(f, '.json');
      if (opts.excludeId && id === opts.excludeId) continue;
      const rec = loadSession(id);
      if (!rec) continue;
      const snippets: string[] = [];
      for (const m of rec.history) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const content = typeof m.content === 'string' ? m.content : '';
        if (content && matcher(content)) {
          const idx = snippets.length + 1;
          snippets.push(`[${m.role}] ${content.slice(0, 200)}`);
          if (idx >= 3) break;
        }
      }
      if (snippets.length > 0) hits.push({ id, updatedAt: rec.updatedAt, snippets });
    }
    return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  } catch {
    return [];
  }
}
