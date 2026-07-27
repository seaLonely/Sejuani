/**
 * Harness 任务清单（H1）：Agent 自主循环的机器可读进度信号。
 * 存于 AgentContext.todos（会话内），随 sessionStore 持久化。
 */

export type TodoStatus = 'pending' | 'in-progress' | 'done' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

/** 目标是否达成：非空且全部 done/cancelled */
export function isAllDone(todos: TodoItem[]): boolean {
  return todos.length > 0 && todos.every((t) => t.status === 'done' || t.status === 'cancelled');
}

/** 完成度摘要（供进度展示） */
export function todoSummary(todos: TodoItem[]): string {
  const done = todos.filter((t) => t.status === 'done').length;
  const cancelled = todos.filter((t) => t.status === 'cancelled').length;
  return `${done + cancelled}/${todos.length}（完成 ${done}${cancelled ? ` · 取消 ${cancelled}` : ''}）`;
}

/** 稳定签名：用于 loopGuard 判定「todo 无状态变化」 */
export function todosSignature(todos: TodoItem[]): string {
  return todos.map((t) => `${t.id}:${t.status}`).join('|');
}

/** 渲染 todo 清单文本（REPL /todos 与进度展示共用） */
export function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return '（暂无任务清单）';
  const mark: Record<TodoStatus, string> = {
    pending: '[ ]',
    'in-progress': '[~]',
    done: '[x]',
    cancelled: '[-]',
  };
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join('\n');
}
