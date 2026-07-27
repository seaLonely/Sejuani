import { Capability, AgentTool, ToolResult, AgentContext } from '../types';
import { listSpecs, loadSpec, saveSpec } from '../../workflow/store';
import { listTemplates } from '../../workflow/templates';
import { buildStepContext } from '../../workflow/context';
import { analyzeImpact } from '../../workflow/impact';
import { planWorkflow } from '../../workflow/planner';
import { runWorkflow } from '../../workflow/engine';
import { StepContext, WorkflowSpec } from '../../workflow/types';
import { aiConfigured } from '../../state/aiConfig';

/**
 * 批量工作流能力模块：规划/执行/续跑均在 Agent 会话内真实完成——
 * 复用 engine 的 confirm/promptInput 注入（REPL 走 inquirer，serve 走 SSE 桥），
 * 危险步骤由 engine 逐一征求用户确认，进度经 onEvent → ctx.print 外发。
 */

/** 渲染 spec 审阅文本（步骤编号/kind/危险标记/待补全参数） */
export function renderSpecSummary(spec: WorkflowSpec): string {
  const lines = spec.steps.map((s, i) => {
    const danger = s.dangerous ? ' [不可逆]' : '';
    const needs = s.needsInput && s.needsInput.length > 0 ? `（执行前需补全: ${s.needsInput.join(', ')}）` : '';
    return `${i + 1}. ${s.title} (${s.kind})${danger}${needs}`;
  });
  return [`工作流: ${spec.title} (${spec.id})`, `域: ${spec.domain} | 步骤: ${spec.steps.length}`, ...lines].join('\n');
}

/**
 * 会话内执行工作流：注入 Agent 的确认/输入回调，进度事件转发到 ctx.print。
 * 供 workflow_run/resume 与 taskflow_fix_bug 共用。
 */
export async function runSpecInSession(
  spec: WorkflowSpec,
  stepCtx: StepContext,
  agentCtx: AgentContext,
  resume: boolean
): Promise<ToolResult> {
  const allOk = await runWorkflow(spec, stepCtx, {
    dryRun: false,
    yes: false,
    resume,
    confirm: (message) => agentCtx.confirm(message),
    promptInput: agentCtx.promptInput,
    onEvent: (e) => {
      if (e.type === 'step-start') {
        agentCtx.print(`  ▸ [${e.index}/${e.total}] ${e.title} ...`);
      } else if (e.type === 'step-end') {
        const mark = e.status === 'ok' ? '✓' : '✗';
        agentCtx.print(`  ${mark} [${e.index}/${e.total}] ${e.title}${e.reason ? `（${e.reason}）` : ''}`);
      }
    },
  });
  return allOk
    ? { success: true, output: `工作流「${spec.title}」执行完成（${spec.steps.length} 步全部成功）。` }
    : {
        success: false,
        output: `工作流「${spec.title}」未全部完成（存在失败或被取消的步骤）。修复后可用 workflow_resume 续跑（workflowId: ${spec.id}）。`,
      };
}

const workflowList: AgentTool = {
  name: 'workflow_list',
  readOnly: true,
  description: '列出所有已保存的 AI 工作流（按时间倒序）',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    const specs = listSpecs();
    if (specs.length === 0) {
      return { success: true, output: '暂无已保存的工作流。可用 workflow_plan 规划一个。' };
    }
    const lines = specs.map((s) => `${s.id}  ${s.title}  [${s.domain}] ${s.steps.length}步  ${s.createdAt}`);
    return { success: true, output: `已保存工作流（${specs.length}）：\n${lines.join('\n')}` };
  },
};

const workflowShow: AgentTool = {
  name: 'workflow_show',
  readOnly: true,
  description: '展示某个工作流的详细步骤信息',
  parameters: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流 ID' },
    },
    required: ['workflowId'],
  },
  async execute(args): Promise<ToolResult> {
    const spec = loadSpec(String(args.workflowId));
    if (!spec) {
      return { success: false, output: `未找到工作流: ${args.workflowId}` };
    }
    return { success: true, output: `${renderSpecSummary(spec)}\n创建: ${spec.createdAt}` };
  },
};

const workflowTemplates: AgentTool = {
  name: 'workflow_templates',
  readOnly: true,
  description: '列出所有已保存的工作流模板',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    const tpls = listTemplates();
    if (tpls.length === 0) {
      return { success: true, output: '暂无工作流模板。可通过 sjn ai --save-template <名> 创建。' };
    }
    const lines = tpls.map((t) => `${t.name}  ${t.title}  ${t.steps.length}步  ${t.savedAt}`);
    return { success: true, output: `工作流模板（${tpls.length}）：\n${lines.join('\n')}` };
  },
};

const workflowPlan: AgentTool = {
  name: 'workflow_plan',
  description: '根据自然语言描述规划一个批量操作工作流并保存（AI 规划 + 确定性影响分析）；规划完成后可用 workflow_run 执行',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '工作流描述（自然语言，如「把 A 组件升级并发布，再升级使用它的工程」）' },
      components: {
        type: 'array',
        items: { type: 'string' },
        description: '可选，目标组件 pkgName 列表；缺省对全部组件规划',
      },
    },
    required: ['description'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const description = String(args.description ?? '').trim();
    if (!description) {
      return { success: false, output: '缺少工作流描述 description。' };
    }
    if (!aiConfigured()) {
      return { success: false, output: '尚未配置 AI apiKey，无法规划。请先执行 sjn ai-config set-key <key>。' };
    }
    const stepCtx = await buildStepContext(ctx.config);
    // 按名单收窄选中组件（缺省全部）
    if (Array.isArray(args.components) && args.components.length > 0) {
      const names = new Set(args.components.map(String));
      const picked = stepCtx.components.filter(
        (c) => (c.pkgName && names.has(c.pkgName)) || names.has(c.name)
      );
      if (picked.length === 0) {
        return { success: false, output: `未在组件库中找到指定组件：${[...names].join(', ')}` };
      }
      stepCtx.selectedComponents = picked;
    }
    const impact = analyzeImpact(stepCtx);
    const spec = await planWorkflow(description, stepCtx, impact);
    saveSpec(spec);
    return {
      success: true,
      output: `已规划并保存工作流：\n${renderSpecSummary(spec)}\n\n请与用户确认步骤后，用 workflow_run（workflowId: ${spec.id}）执行；危险步骤会逐一征求确认。`,
    };
  },
};

const workflowRun: AgentTool = {
  name: 'workflow_run',
  description: '在会话内执行一个已保存的工作流（危险步骤会逐一征求用户确认，进度实时输出）',
  parameters: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流 ID' },
    },
    required: ['workflowId'],
  },
  needsConfirm: true,
  async execute(args, ctx): Promise<ToolResult> {
    const spec = loadSpec(String(args.workflowId));
    if (!spec) {
      return { success: false, output: `未找到工作流: ${args.workflowId}` };
    }
    const stepCtx = await buildStepContext(ctx.config, spec);
    return runSpecInSession(spec, stepCtx, ctx, false);
  },
};

const workflowResume: AgentTool = {
  name: 'workflow_resume',
  description: '在会话内续跑一个之前失败的工作流（跳过已成功步骤，从断点处继续）',
  parameters: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流 ID' },
    },
    required: ['workflowId'],
  },
  needsConfirm: true,
  async execute(args, ctx): Promise<ToolResult> {
    const spec = loadSpec(String(args.workflowId));
    if (!spec) {
      return { success: false, output: `未找到工作流: ${args.workflowId}` };
    }
    const stepCtx = await buildStepContext(ctx.config, spec);
    return runSpecInSession(spec, stepCtx, ctx, true);
  },
};

export const workflowCapability: Capability = {
  name: 'workflow',
  description: '批量操作工作流：会话内规划（workflow_plan）、执行（workflow_run）、续跑（workflow_resume）、查看与模板管理',
  tools: [workflowList, workflowShow, workflowTemplates, workflowPlan, workflowRun, workflowResume],
};
