import { Capability, AgentTool, ToolResult, AgentContext } from '../types';
import { AgentHarness } from '../harness';
import { getAllTools } from '../registry';

/**
 * 子代理派发（agent_dispatch）：主 Agent 把定义清晰的独立子任务交给一次性子 Agent 执行。
 * 子 Agent 有独立上下文（不继承主会话历史、不持久化）、受限工具集、独立紧预算，
 * 跑完把结构化结果摘要回传主 Agent。支持多子任务并行（仅只读白名单时真正并发）。
 * 安全：MAX_DEPTH=1（子代理不可再派发）；子代理 grantedTools 恒空；危险工具走父 confirm 桥。
 */

const MAX_DEPTH = 1;
const SUB_BUDGET = { maxToolCalls: 20, maxWallClockMs: 3 * 60 * 1000 };
const SUB_MAX_ITERATIONS = 4;

interface SubTask {
  goal: string;
  allowTools?: string[];
  maxRounds?: number;
}

/** 缺省子代理白名单：全部只读工具（含 code 只读），不含任何写/危险工具 */
function readOnlyToolNames(): string[] {
  return getAllTools().filter((t) => t.readOnly && !t.external).map((t) => t.name);
}

/** 是否为只读白名单（决定能否并行） */
function isReadOnlyWhitelist(allow: string[]): boolean {
  const readOnly = new Set(readOnlyToolNames());
  return allow.every((n) => readOnly.has(n));
}

async function runSub(task: SubTask, ctx: AgentContext): Promise<string> {
  const allowTools = Array.isArray(task.allowTools) && task.allowTools.length > 0
    ? task.allowTools.map(String)
    : readOnlyToolNames();
  const harness = new AgentHarness(ctx.config, {
    allowTools,
    grantedTools: [], // 子代理不预授权任何危险工具
    aiRole: 'agentTask',
    budget: SUB_BUDGET,
    maxIterations: SUB_MAX_ITERATIONS,
    subagentDepth: ctx.subagentDepth + 1, // 关键：深度+1，子代理内 agent_dispatch 不可见
    memoryDomain: ctx.domain,
  });
  // 危险确认继承父 confirm 桥（交互在场确认；无人值守父 confirm 恒 false → 子代理危险工具被拒）
  harness.getBrain().setConfirm(ctx.confirm);
  const r = await harness.runGoal(task.goal);
  const done = r.todos.filter((t) => t.status === 'done').length;
  return [
    `▸ 子任务：${task.goal.slice(0, 60)}`,
    `  终局：${r.outcome} · 迭代 ${r.iterations} · 任务 ${done}/${r.todos.length} · 工具 ${r.usage.toolCalls} 次`,
    `  结论：${r.summary.slice(0, 500)}`,
  ].join('\n');
}

const agentDispatch: AgentTool = {
  name: 'agent_dispatch',
  readOnly: false,
  description:
    '把一个或多个独立子任务派发给一次性子 Agent 执行（各有独立上下文与受限工具集），汇总结论回传。' +
    '适合把复杂任务拆成可并行的探索/分析子任务（如分别分析多个模块）。' +
    '注意：子任务目标须自包含（把必要背景写进 goal，子 Agent 看不到当前对话历史）；子 Agent 缺省只有只读工具。',
  parameters: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        description: '子任务数组',
        items: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: '自包含的子任务目标' },
            allowTools: { type: 'array', items: { type: 'string' }, description: '子 Agent 工具白名单；缺省=全部只读工具' },
            maxRounds: { type: 'number', description: '子 Agent 单轮工具循环上限，默认 6' },
          },
          required: ['goal'],
        },
      },
      parallel: { type: 'boolean', description: '多任务是否并行，默认 true（仅全部只读白名单时真正并发）' },
    },
    required: ['tasks'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    // 深度守卫：子代理（depth≥MAX_DEPTH）不可再派发
    if (ctx.subagentDepth >= MAX_DEPTH) {
      return { success: false, output: `子代理不可再派发子代理（深度上限 ${MAX_DEPTH}）。请在当前子任务内直接完成。` };
    }
    const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
    const tasks: SubTask[] = rawTasks
      .map((t: any) => ({ goal: String(t.goal ?? '').trim(), allowTools: t.allowTools, maxRounds: t.maxRounds }))
      .filter((t: SubTask) => t.goal);
    if (tasks.length === 0) return { success: false, output: '缺少有效子任务（tasks[].goal）' };
    if (tasks.length > 5) return { success: false, output: '单次最多派发 5 个子任务' };

    // 并行判定：显式 parallel!==false 且全部子任务为只读白名单才并发，否则串行
    const allReadOnly = tasks.every((t) =>
      isReadOnlyWhitelist(Array.isArray(t.allowTools) && t.allowTools.length > 0 ? t.allowTools.map(String) : readOnlyToolNames())
    );
    const parallel = args.parallel !== false && allReadOnly && tasks.length > 1;

    ctx.print(`派发 ${tasks.length} 个子任务（${parallel ? '并行' : '串行'}）…`);
    let results: string[];
    if (parallel) {
      results = await Promise.all(tasks.map((t) => runSub(t, ctx)));
    } else {
      results = [];
      for (const t of tasks) results.push(await runSub(t, ctx));
    }
    return { success: true, output: `子任务汇总（${tasks.length}）：\n\n${results.join('\n\n')}` };
  },
};

export const subagentCapability: Capability = {
  name: 'subagent',
  description: '子代理派发：把独立子任务交给一次性子 Agent 并行探索/分析并汇总',
  tools: [agentDispatch],
};
