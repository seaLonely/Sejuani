import { Capability, AgentTool, ToolResult } from '../types';
import { searchSessions, loadSession } from '../sessionStore';
import { chatJSON, ChatMessage } from '../../aiClient';

/**
 * 会话搜索能力（U2）：跨会话召回历史结论。纯只读，不改存储。
 *  - session_search：关键词/正则扫描全部会话，返回命中会话 id + 片段；
 *  - session_recall：读某会话，可选 LLM 摘要（summarize:true 时才调，控成本）。
 */

const sessionSearch: AgentTool = {
  name: 'session_search',
  readOnly: true,
  description: '跨历史会话搜索（关键词/正则），召回过去讨论过的结论。返回命中会话 id 与片段。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或正则' },
      regex: { type: 'boolean', description: '是否按正则匹配（默认关键词）' },
      limit: { type: 'number', description: '最多返回会话数（默认 10）' },
    },
    required: ['query'],
  },
  async execute(args): Promise<ToolResult> {
    const hits = searchSessions(String(args.query), {
      regex: args.regex === true,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    });
    if (hits.length === 0) return { success: true, output: `未找到匹配「${args.query}」的历史会话。` };
    const lines = hits.map((h) => `【会话 ${h.id}】(${h.updatedAt})\n  ${h.snippets.join('\n  ')}`);
    return { success: true, output: lines.join('\n\n'), data: hits };
  },
};

const sessionRecall: AgentTool = {
  name: 'session_recall',
  readOnly: true,
  description: '读取某个历史会话的内容；summarize=true 时用 AI 摘要该会话要点。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '会话 id（来自 session_search）' },
      summarize: { type: 'boolean', description: '是否 AI 摘要（默认返回原始片段）' },
    },
    required: ['id'],
  },
  async execute(args): Promise<ToolResult> {
    const rec = loadSession(String(args.id));
    if (!rec) return { success: false, output: `会话不存在：${args.id}` };
    const turns = rec.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `[${m.role}] ${typeof m.content === 'string' ? m.content : ''}`)
      .filter((t) => t.trim().length > 4);
    const raw = turns.join('\n').slice(0, 8000);
    if (args.summarize !== true) {
      return { success: true, output: raw || '（该会话无文本内容）' };
    }
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: '用简洁中文总结以下历史会话的关键结论与产出，输出 JSON：{"summary":"..."}' },
        { role: 'user', content: raw },
      ];
      const obj = await chatJSON(messages, { role: 'compress' });
      const summary = typeof obj === 'object' && obj?.summary ? String(obj.summary) : JSON.stringify(obj);
      return { success: true, output: summary };
    } catch (err) {
      return { success: true, output: raw, data: { summarizeError: (err as Error).message } };
    }
  },
};

export const sessionCapability: Capability = {
  name: 'session',
  description: '会话搜索与召回：跨历史会话检索过去的结论',
  tools: [sessionSearch, sessionRecall],
};
