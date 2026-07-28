import { Capability, AgentTool, ToolResult } from '../types';
import { upsertMemory, forgetMemory, listMemory, MemoryCategory } from '../memory';

/**
 * 记忆能力模块（S2）：让 Agent 在对话中主动沉淀/读取/清理跨会话长期记忆。
 * 记忆按当前域隔离存储；memory_write/forget 为纯本地状态，无需确认。
 */

const CATEGORIES: MemoryCategory[] = ['profile', 'preference', 'project', 'lesson'];

const memoryWrite: AgentTool = {
  name: 'memory_write',
  readOnly: false,
  description:
    '写入长期记忆（跨会话保留）。当用户表达偏好、纠正你的做法、约定命名/流程、或确认了重要项目事实时主动调用。category: preference(用户偏好)/project(项目事实)/lesson(经验教训)。',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: '记忆内容（简洁陈述，≤200 字符）' },
      category: { type: 'string', enum: CATEGORIES, description: '类别：profile(用户画像:你是谁/团队/常用域)/preference(偏好)/project(项目事实)/lesson(教训)，缺省 preference' },
      id: { type: 'string', description: '可选，更新已有记忆时传其 id' },
    },
    required: ['content'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const content = String(args.content ?? '').trim();
    if (!content) return { success: false, output: '记忆内容为空' };
    const category = CATEGORIES.includes(args.category) ? (args.category as MemoryCategory) : 'preference';
    const entry = upsertMemory(ctx.domain, { content, category, id: args.id ? String(args.id) : undefined });
    return { success: true, output: `已记住 [${entry.category}] ${entry.content}（id=${entry.id}）` };
  },
};

const memoryRead: AgentTool = {
  name: 'memory_read',
  readOnly: true,
  description: '读取当前域的全部长期记忆（按类别与权重排序）。',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx): Promise<ToolResult> {
    const entries = listMemory(ctx.domain);
    if (entries.length === 0) return { success: true, output: '（暂无长期记忆）' };
    const lines = entries.map((e) => `[${e.category}] (w${e.weight}) ${e.content}  #${e.id}`);
    return { success: true, output: lines.join('\n'), data: entries };
  },
};

const memoryForget: AgentTool = {
  name: 'memory_forget',
  readOnly: false,
  description: '删除一条长期记忆（当记忆已过期或被用户否定时）。需传记忆 id（可先用 memory_read 查）。',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: '记忆 id' } },
    required: ['id'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const ok = forgetMemory(ctx.domain, String(args.id));
    return { success: ok, output: ok ? `已删除记忆 ${args.id}` : `未找到记忆 ${args.id}` };
  },
};

export const memoryCapability: Capability = {
  name: 'memory',
  description: '长期记忆：跨会话记住用户偏好、项目事实与经验教训',
  tools: [memoryWrite, memoryRead, memoryForget],
};
