import { logger } from '../../../utils/logger';
import { StepContext, WorkflowStep } from '../types';
import { StepHandler, StepExecResult } from './contract';
import { renderParams, stepsView, ExprContext } from '../expr';
import { STEP_HANDLERS } from './index';
import { loadSkill } from '../../skill/store';

/**
 * skill.invoke（K2）：在工作流步骤中调用一个已保存的技能，实现「工作流 × skills 可组合」。
 *  - workflow 型：把技能步骤内联展开为子步骤串行执行（产物聚合为 results）；
 *  - prompt 型：转为一次 agent.task（guide 作为目标），复用其白名单/预算安全约束。
 * 安全：
 *  - 禁止危险子步骤（与 flow.foreach 一致，危险操作须作顶层步骤走确认/批准）；
 *  - 循环守卫：技能调用栈中出现同名技能即拒绝；深度上限 MAX_SKILL_DEPTH。
 */

const MAX_SKILL_DEPTH = 3;

function baseCtx(ctx: StepContext, params?: Record<string, unknown>): ExprContext {
  return {
    steps: stepsView(ctx.runOutputs),
    trigger: ctx.trigger,
    env: { domain: ctx.config.activeDomain },
    item: params,
  };
}

export const skillInvoke: StepHandler = {
  kind: 'skill.invoke',
  describe: () => ({
    kind: 'skill.invoke',
    summary: '调用一个已保存的技能：workflow 型内联展开其步骤串行执行，prompt 型交 AI 按指南执行。',
    params: {
      name: '必填，技能名（sjn skill list 可查）',
      params: '可选，传给技能的参数对象；子步骤 params 中可用 {{item.<field>}} 引用',
    },
    dangerous: false,
  }),
  preview: (step) => {
    return [`调用技能 ${String(step.params.name ?? '<name>')}`];
  },
  execute: async (step, ctx): Promise<StepExecResult> => {
    const name = String(step.params.name ?? '').trim();
    if (!name) return { ok: false, reason: '缺少必填参数 name' };

    // 循环/深度守卫：调用栈经 ctx 透传，任何嵌套路径（含 flow.foreach）都天然继承
    const stack: string[] = Array.isArray(ctx.skillStack) ? ctx.skillStack : [];
    if (stack.includes(name)) {
      return { ok: false, reason: `检测到技能循环调用：${[...stack, name].join(' → ')}` };
    }
    if (stack.length >= MAX_SKILL_DEPTH) {
      return { ok: false, reason: `技能调用深度超过上限 ${MAX_SKILL_DEPTH}` };
    }

    const skill = loadSkill(name);
    if (!skill) return { ok: false, reason: `技能不存在：${name}` };

    const invokeParams =
      step.params.params && typeof step.params.params === 'object'
        ? (step.params.params as Record<string, unknown>)
        : {};

    // prompt 型：转为一次 agent.task（复用其白名单/预算安全约束）
    if (skill.kind === 'prompt') {
      const goal = `${skill.guide ?? ''}${Object.keys(invokeParams).length ? `\n\n参数：${JSON.stringify(invokeParams)}` : ''}`.trim();
      const synthetic: WorkflowStep = {
        id: `${step.id}.agent`,
        kind: 'agent.task',
        title: `技能 ${name}`,
        params: { goal },
      };
      return STEP_HANDLERS['agent.task'].execute(synthetic, ctx);
    }

    // workflow 型：内联展开子步骤串行执行
    const subSteps = skill.steps ?? [];
    if (subSteps.length === 0) return { ok: false, reason: `技能 ${name} 无步骤` };
    const dangerousSub = subSteps.find(
      (s) => s.dangerous || (STEP_HANDLERS[s.kind]?.describe().dangerous ?? false)
    );
    if (dangerousSub) {
      return {
        ok: false,
        reason: `技能含危险步骤（${dangerousSub.kind}），禁止经 skill.invoke 执行；请将危险操作作为顶层步骤以经过确认/批准流程`,
      };
    }

    // 压栈：本次调用期间 ctx.skillStack 含当前技能名，供任意深度的嵌套 skill.invoke 检测循环；finally 恢复
    const prevStack = ctx.skillStack;
    ctx.skillStack = [...stack, name];
    try {
      const results: Array<{ step: string; ok: boolean; reason?: string }> = [];
      for (const sub of subSteps) {
        const handler = STEP_HANDLERS[sub.kind];
        if (!handler) {
          results.push({ step: sub.id ?? sub.kind, ok: false, reason: `未知子步骤 kind: ${sub.kind}` });
          return { ok: false, reason: `未知子步骤 kind: ${sub.kind}`, outputs: { results } };
        }
        const rendered: WorkflowStep = {
          id: `${step.id}.${sub.id ?? sub.kind}`,
          kind: sub.kind,
          title: sub.title ?? sub.kind,
          params: renderParams(sub.params ?? {}, baseCtx(ctx, invokeParams)),
        };
        logger.step(`  [skill ${name}] ${rendered.title}`);
        try {
          const r = await handler.execute(rendered, ctx);
          results.push({ step: rendered.id, ok: r.ok, reason: r.reason });
          if (!r.ok) return { ok: false, reason: `子步骤 ${rendered.title} 失败：${r.reason ?? ''}`, outputs: { results } };
        } catch (err) {
          results.push({ step: rendered.id, ok: false, reason: (err as Error).message });
          return { ok: false, reason: (err as Error).message, outputs: { results } };
        }
      }
      return { ok: true, reason: `技能 ${name} 执行完成（${subSteps.length} 步）`, outputs: { results } };
    } finally {
      ctx.skillStack = prevStack;
    }
  },
};
