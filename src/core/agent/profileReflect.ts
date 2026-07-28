import { SejuaniConfig } from '../config';
import { ChatMessage, chatJSON, extractJsonObject } from '../aiClient';
import { listMemory, upsertMemory } from './memory';

/**
 * 用户画像动态建模（对标 Hermes Honcho 的"辩证式跨会话建模"，零依赖轻量版）：
 * 读当前会话轨迹 + 已有 profile 记忆 → LLM 推断稳定的"用户是谁"事实 → 增量更新 profile 记忆。
 * 与静态 profile 记忆条目的区别：由对话动态推断、去重合并，而非仅用户显式声明。
 */

const REFLECT_SYSTEM = [
  '你是用户画像分析助手。基于给定对话轨迹与已有画像，推断关于用户的"稳定、长期"事实（身份/团队/技术栈偏好/工作习惯/常用域）。',
  '只输出跨会话仍成立的稳定事实，忽略一次性、临时性内容。每条简洁陈述（≤50 字），最多 6 条。',
  '与已有画像去重：仅输出"新增或需修正"的事实。若无新增，返回空数组。',
  '只返回 JSON：{"facts":["事实1","事实2"]}。',
].join('\n');

/** 从会话轨迹反思出用户画像事实（不落盘，返回建议列表） */
export async function reflectUserProfile(
  config: SejuaniConfig,
  history: ChatMessage[]
): Promise<string[]> {
  const turns = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : ''}`)
    .filter((t) => t.trim().length > 4);
  if (turns.length === 0) return [];
  const existing = listMemory(config.activeDomain)
    .filter((m) => m.category === 'profile')
    .map((m) => m.content);
  const messages: ChatMessage[] = [
    { role: 'system', content: REFLECT_SYSTEM },
    {
      role: 'user',
      content: `已有画像：\n${existing.length ? existing.join('\n') : '（无）'}\n\n对话轨迹：\n${turns.join('\n').slice(0, 10000)}`,
    },
  ];
  try {
    const raw = await chatJSON(messages, { role: 'compress' });
    const obj = typeof raw === 'string' ? extractJsonObject(raw) : raw;
    const facts = Array.isArray(obj?.facts) ? obj.facts.map(String).filter((s: string) => s.trim()) : [];
    return facts.slice(0, 6);
  } catch {
    return [];
  }
}

/** 把画像事实写入 profile 记忆（去重合并由 upsertMemory 负责） */
export function saveProfileFacts(domain: string, facts: string[]): number {
  let n = 0;
  for (const f of facts) {
    upsertMemory(domain, { content: f, category: 'profile' });
    n++;
  }
  return n;
}
