import { Capability, AgentTool, ToolResult } from '../types';
import { TodoItem, TodoStatus, renderTodos } from '../todo';

/**
 * 任务清单能力（H1）：Agent 自主循环中拆解目标与更新进度。
 * 纯会话内状态（ctx.todos），无外部副作用，无需确认。
 */

const STATUSES: TodoStatus[] = ['pending', 'in-progress', 'done', 'cancelled'];

const todoWrite: AgentTool = {
  name: 'todo_write',
  readOnly: false,
  description:
    '整表覆写任务清单（用于拆解目标与更新进度）。给定完整的 todo 数组：[{id, content, status}]。status: pending/in-progress/done/cancelled。开始一个目标时先拆解，每完成一项就更新其 status。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整任务清单',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['content'],
        },
      },
    },
    required: ['todos'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const raw = Array.isArray(args.todos) ? args.todos : [];
    const todos: TodoItem[] = raw.map((t: any, i: number) => ({
      id: typeof t.id === 'string' && t.id.trim() ? t.id : `t${i + 1}`,
      content: String(t.content ?? '').trim(),
      status: STATUSES.includes(t.status) ? t.status : 'pending',
    })).filter((t: TodoItem) => t.content);
    ctx.todos = todos;
    return { success: true, output: `任务清单已更新（${todos.length} 项）：\n${renderTodos(todos)}` };
  },
};

const todoRead: AgentTool = {
  name: 'todo_read',
  readOnly: true,
  description: '读取当前任务清单与完成状态。',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx): Promise<ToolResult> {
    return { success: true, output: renderTodos(ctx.todos), data: ctx.todos };
  },
};

export const todoCapability: Capability = {
  name: 'todo',
  description: '任务清单：拆解目标、跟踪多步任务进度（自主执行时使用）',
  tools: [todoWrite, todoRead],
};
