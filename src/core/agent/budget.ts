import { AgentStats } from './sessionStore';

/**
 * Harness 预算闸（H1）：token / 工具调用 / 墙钟三维上限。
 * 纯函数；数据来自现有 AgentStats。缺省宽松（仅 15 分钟墙钟安全网），
 * 调用方按场景收紧（如 agent.task 巡检）。
 */

export interface BudgetSpec {
  maxTotalTokens?: number;
  maxToolCalls?: number;
  maxWallClockMs?: number;
}

/** 缺省预算：不限 token/调用，墙钟 15 分钟 */
export const DEFAULT_BUDGET: Required<Pick<BudgetSpec, 'maxWallClockMs'>> = {
  maxWallClockMs: 15 * 60 * 1000,
};

/** 检查预算是否仍在范围内；超限返回 { ok:false, reason } */
export function checkBudget(
  spec: BudgetSpec,
  stats: AgentStats,
  startedAt: number
): { ok: boolean; reason?: string } {
  const totalTokens = stats.promptTokens + stats.completionTokens;
  if (spec.maxTotalTokens !== undefined && totalTokens >= spec.maxTotalTokens) {
    return { ok: false, reason: `token 预算耗尽（${totalTokens}/${spec.maxTotalTokens}）` };
  }
  if (spec.maxToolCalls !== undefined && stats.toolCalls >= spec.maxToolCalls) {
    return { ok: false, reason: `工具调用预算耗尽（${stats.toolCalls}/${spec.maxToolCalls}）` };
  }
  const wall = spec.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs;
  const elapsed = Date.now() - startedAt;
  if (elapsed >= wall) {
    return { ok: false, reason: `墙钟预算耗尽（${Math.round(elapsed / 1000)}s/${Math.round(wall / 1000)}s）` };
  }
  return { ok: true };
}
