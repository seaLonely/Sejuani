import { SejuaniConfig } from '../config';
import { ConfirmFn, PromptInputFn } from '../types';
import { Skill } from './types';
import { WorkflowSpec } from '../workflow/types';
import { buildStepContext } from '../workflow/context';
import { runWorkflow } from '../workflow/engine';
import { genWorkflowId } from '../workflow/planner';
import { AgentHarness } from '../agent/harness';
import { getAllTools } from '../agent/registry';

/**
 * Skill 执行共享路径（K1.3）：CLI（sjn skill run）与 agent 工具（skill_run）复用同一实现，
 * 避免行为分叉。workflow 型走引擎，prompt 型走一次性 AgentHarness（独立上下文，不污染主会话）。
 */

export interface RunSkillOptions {
  yes?: boolean;
  confirm?: ConfirmFn;
  promptInput?: PromptInputFn;
  params?: Record<string, any>;
}

export async function runSkill(
  config: SejuaniConfig,
  skill: Skill,
  opts: RunSkillOptions = {}
): Promise<{ ok: boolean; summary: string }> {
  if (skill.kind === 'workflow') {
    const steps = skill.steps ?? [];
    if (steps.length === 0) return { ok: false, summary: 'workflow 型技能无步骤' };
    const spec: WorkflowSpec = {
      id: genWorkflowId(`skill-${skill.name}`),
      title: `技能：${skill.title || skill.name}`,
      createdAt: new Date().toISOString(),
      domain: config.activeDomain,
      steps,
    };
    const ctx = await buildStepContext(config, spec, { yes: !!opts.yes });
    const ok = await runWorkflow(spec, ctx, {
      dryRun: false,
      yes: !!opts.yes,
      resume: false,
      confirm: opts.confirm,
      promptInput: opts.promptInput,
    });
    return { ok, summary: `技能 ${skill.name} 执行${ok ? '完成' : '未全部成功'}` };
  }

  // prompt 型：一次性 AgentHarness，独立上下文
  const goal = `${skill.guide ?? ''}${opts.params ? `\n\n参数：${JSON.stringify(opts.params)}` : ''}`.trim();
  if (!goal) return { ok: false, summary: 'prompt 型技能无 guide' };
  // 安全：缺省只给只读工具白名单（对齐 agent.task），避免 prompt 技能静默驱动写类/外发工具
  const readOnlyTools = getAllTools().filter((t) => t.readOnly && !t.external).map((t) => t.name);
  const harness = new AgentHarness(config, {
    allowTools: readOnlyTools,
    grantedTools: readOnlyTools,
    aiRole: 'agentTask',
    budget: { maxToolCalls: 20, maxWallClockMs: 5 * 60 * 1000 },
  });
  // 危险确认继承调用方 confirm；缺省显式拒绝（不依赖 Brain 的恒 true 缺省）
  harness.getBrain().setConfirm(opts.confirm ?? (async () => false));
  const r = await harness.runGoal(goal);
  return { ok: r.outcome === 'completed', summary: r.summary };
}
