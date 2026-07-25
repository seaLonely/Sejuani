import { Capability, AgentTool, ToolResult } from '../types';
import { listSpecs, loadSpec } from '../../workflow/store';
import { listTemplates } from '../../workflow/templates';

/**
 * 批量工作流能力模块：列出/查看/执行已保存工作流与模板。
 * 注：workflow_plan（AI 规划）需交互式选组件，此处仅提供查询和触发执行能力。
 */

const workflowList: AgentTool = {
  name: 'workflow_list',
  description: '列出所有已保存的 AI 工作流（按时间倒序）',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    const specs = listSpecs();
    if (specs.length === 0) {
      return { success: true, output: '暂无已保存的工作流。可通过 sjn ai 创建。' };
    }
    const lines = specs.map((s) => `${s.id}  ${s.title}  [${s.domain}] ${s.steps.length}步  ${s.createdAt}`);
    return { success: true, output: `已保存工作流（${specs.length}）：\n${lines.join('\n')}` };
  },
};

const workflowShow: AgentTool = {
  name: 'workflow_show',
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
    const lines = [
      `工作流: ${spec.title} (${spec.id})`,
      `域: ${spec.domain} | 创建: ${spec.createdAt} | 步骤: ${spec.steps.length}`,
      '',
      ...spec.steps.map((s, i) => {
        const danger = s.dangerous ? ' [不可逆]' : '';
        return `${i + 1}. ${s.title} (${s.kind})${danger}`;
      }),
    ];
    return { success: true, output: lines.join('\n') };
  },
};

const workflowTemplates: AgentTool = {
  name: 'workflow_templates',
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
  description: '根据自然语言描述规划一个新的批量操作工作流（需要先选择目标组件，建议用户通过 sjn ai 交互式执行）',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: '工作流描述（自然语言）' },
    },
    required: ['description'],
  },
  async execute(args): Promise<ToolResult> {
    return {
      success: true,
      output: `收到工作流规划请求：「${args.description}」\n该操作需要交互式选择目标组件，建议用户执行：sjn ai "${args.description}"`,
    };
  },
};

const workflowRun: AgentTool = {
  name: 'workflow_run',
  description: '执行一个已保存的工作流（需要交互确认危险步骤，建议通过 sjn flow run <id> 执行）',
  parameters: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '工作流 ID' },
    },
    required: ['workflowId'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const spec = loadSpec(String(args.workflowId));
    if (!spec) {
      return { success: false, output: `未找到工作流: ${args.workflowId}` };
    }
    return {
      success: true,
      output: `工作流「${spec.title}」（${spec.steps.length}步）需要交互式执行。请运行：sjn flow run ${args.workflowId}`,
    };
  },
};

const workflowResume: AgentTool = {
  name: 'workflow_resume',
  description: '续跑一个之前失败的工作流（从断点处继续）',
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
    return {
      success: true,
      output: `续跑工作流「${spec.title}」，请运行：sjn flow resume ${args.workflowId}`,
    };
  },
};

export const workflowCapability: Capability = {
  name: 'workflow',
  description: '批量操作工作流：查看/执行已保存工作流、模板管理、规划新工作流',
  tools: [workflowList, workflowShow, workflowTemplates, workflowPlan, workflowRun, workflowResume],
};
