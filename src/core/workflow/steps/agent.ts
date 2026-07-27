import { logger } from '../../../utils/logger';
import { StepHandler } from './contract';
import { AgentBrain } from '../../agent/brain';
import { AgentHarness } from '../../agent/harness';
import { BudgetSpec } from '../../agent/budget';
import { getAllTools } from '../../agent/registry';

/**
 * AI 自主步骤（W4）：把一段自然语言目标交给一次性 AgentBrain 在受限工具集内执行。
 * 无人值守安全约束：
 * - 工具白名单（缺省 = 全部只读工具 + yunxiao_comment），白名单外工具对 LLM 不可见；
 * - 白名单即授权边界：名单内的 needsConfirm 工具预授权（spec 作者显式声明即视为授权），
 *   名单外公式上不可达，confirm 恒拒绝仅作兼容兜底。
 */

/** 缺省白名单：全部只读工具 + 工单评论（含只读编码工具，不含写类 code 工具） */
function defaultAllowTools(): string[] {
  return [...getAllTools().filter((t) => t.readOnly).map((t) => t.name), 'yunxiao_comment'];
}

export const agentTask: StepHandler = {
  kind: 'agent.task',
  describe: () => ({
    kind: 'agent.task',
    summary: '把自然语言目标交给 AI Agent 在受限工具集内自主执行（如分析工单并评论、生成依赖日报）。',
    params: {
      goal: '必填，自然语言目标；支持表达式（如 "分析工单 {{trigger.item.identifier}} 并分类评论"）',
      allowTools: '可选，工具名白名单数组；缺省 = 全部只读工具 + yunxiao_comment',
      maxRounds: '可选，每轮最大 LLM 循环次数，默认 6',
      harness: '可选，true=Harness 自主循环模式（拆 todo 迭代到目标达成/预算耗尽，而非只跑一轮）；缺省 false',
      budget: "可选，harness 模式预算（缺省 { maxToolCalls:30, maxWallClockMs:300000 }）",
    },
    dangerous: false,
  }),
  preview: (step) => {
    const goal = String(step.params.goal ?? '<goal>');
    const tools = Array.isArray(step.params.allowTools) ? step.params.allowTools.length : '缺省(只读+评论)';
    return [`AI 目标：${goal.slice(0, 120)}`, `  工具白名单：${tools} · 轮次上限：${step.params.maxRounds ?? 6}`];
  },
  execute: async (step, ctx) => {
    const goal = String(step.params.goal ?? '').trim();
    if (!goal) return { ok: false, reason: '缺少必填参数 goal' };
    const allowTools = Array.isArray(step.params.allowTools) && step.params.allowTools.length > 0
      ? step.params.allowTools.map(String)
      : defaultAllowTools();
    const maxRounds = typeof step.params.maxRounds === 'number' && step.params.maxRounds > 0
      ? step.params.maxRounds
      : 6;

    // Harness 自主循环模式（H1）：巡检从「跑一轮」升级为「跑到目标达成或预算耗尽」
    if (step.params.harness === true) {
      const budget: BudgetSpec =
        step.params.budget && typeof step.params.budget === 'object'
          ? step.params.budget
          : { maxToolCalls: 30, maxWallClockMs: 5 * 60 * 1000 };
      // 强制并入无副作用的会话内工具：harness 靠 todo_write 拆解迭代，memory_write 支撑 H4 沉淀
      const harnessTools = [...new Set([...allowTools, 'todo_write', 'todo_read', 'memory_write', 'memory_read'])];
      const harness = new AgentHarness(ctx.config, {
        allowTools: harnessTools,
        grantedTools: harnessTools,
        aiRole: 'agentTask',
        budget,
        memoryDomain: ctx.config.activeDomain,
      });
      harness.getBrain().setConfirm(async () => false);
      harness.getBrain().setPrint((text) => logger.info(text));
      const r = await harness.runGoal(goal);
      const done = r.todos.filter((t) => t.status === 'done').length;
      return {
        ok: r.outcome === 'completed',
        reason: `Harness 终局 ${r.outcome}（迭代 ${r.iterations} 轮 · 任务 ${done}/${r.todos.length} · 工具 ${r.usage.toolCalls} 次）`,
        outputs: {
          reply: r.summary,
          outcome: r.outcome,
          todos: r.todos,
          iterations: r.iterations,
          toolCalls: r.usage.toolCalls,
          promptTokens: r.usage.promptTokens,
          completionTokens: r.usage.completionTokens,
        },
      };
    }

    const brain = new AgentBrain(ctx.config, { allowTools, maxRounds, grantedTools: allowTools, aiRole: 'agentTask' });
    // 兜底：白名单外的 needsConfirm 路径（理论上不可达）一律拒绝
    brain.setConfirm(async () => false);
    brain.setPrint((text) => logger.info(text));

    const reply = await brain.process(goal);
    const stats = brain.getStats();
    const ok = !reply.startsWith('[Agent 错误]');
    return {
      ok,
      reason: ok ? `AI 完成（${stats.rounds} 轮 / ${stats.toolCalls} 次工具调用）` : reply.slice(0, 200),
      outputs: {
        reply,
        rounds: stats.rounds,
        toolCalls: stats.toolCalls,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
      },
    };
  },
};
