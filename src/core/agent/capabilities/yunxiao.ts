import { Capability, AgentTool, ToolResult } from '../types';
import * as yunxiao from '../../yunxiao/api';
import { getYunxiaoConfig, setYunxiaoConfig } from '../../yunxiaoConfig';
import { ensureYunxiaoConfigured } from '../../../ui/yunxiaoFlow';

/**
 * 云效需求缺陷管理能力模块：工单查询/详情/流转/评论/迭代/成员/设置。
 */

const yunxiaoListTasks: AgentTool = {
  name: 'yunxiao_list_tasks',
  description: '查询云效工作项列表（需求/缺陷/任务），支持按类型、状态、迭代、关键词过滤',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['Req', 'Bug', 'Task'], description: '工作项类型过滤' },
      status: { type: 'string', description: '按状态名过滤（包含匹配）' },
      sprint: { type: 'string', description: '迭代 ID（覆盖默认迭代）' },
      keyword: { type: 'string', description: '按标题/编号搜索' },
      limit: { type: 'number', description: '返回条数上限，默认 20' },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    if (!ensureYunxiaoConfigured()) {
      return { success: false, output: '云效未配置，请先执行 sjn yunxiao-config set-project <项目ID>' };
    }
    const items = await yunxiao.listWorkItems({
      type: args.type,
      statusName: args.status,
      sprintId: args.sprint,
      keyword: args.keyword,
      limit: args.limit ?? 20,
      applyDefaults: true,
    });
    if (items.length === 0) {
      return { success: true, output: '没有找到匹配的工作项。' };
    }
    const lines = items.map((w) => `${w.identifier}  ${yunxiao.typeLabel(w.type)}  ${w.subject}  [${w.statusName}]  ${w.assignedTo}`);
    return { success: true, output: `工作项（${items.length}）：\n${lines.join('\n')}` };
  },
};

const yunxiaoViewTask: AgentTool = {
  name: 'yunxiao_view_task',
  description: '查看单个云效工单的详细信息与评论历史',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '工单 ID（如 BENZ-5650）' },
    },
    required: ['taskId'],
  },
  async execute(args): Promise<ToolResult> {
    const issue = await yunxiao.getWorkItem(String(args.taskId));
    const comments = await yunxiao.listComments(issue.id);
    const lines = [
      `编号: ${issue.identifier}`,
      `标题: ${issue.subject}`,
      `类型: ${yunxiao.typeLabel(issue.type)} | 状态: ${issue.statusName} | 负责人: ${issue.assignedTo}`,
      issue.description ? `描述: ${issue.description.slice(0, 500)}` : '',
      '',
      `评论（${comments.length}）：`,
      ...comments.map((c) => `  [${c.createdAt}] ${c.author}: ${c.content.slice(0, 200)}`),
    ].filter(Boolean);
    return { success: true, output: lines.join('\n') };
  },
};

const yunxiaoTransition: AgentTool = {
  name: 'yunxiao_transition',
  description: '流转云效工单状态（如 待处理→开发中→待测试→已完成）',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '工单 ID' },
      toStatus: { type: 'string', description: '目标状态名（如 开发中、待测试、已完成）' },
    },
    required: ['taskId', 'toStatus'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const issue = await yunxiao.getWorkItem(String(args.taskId));
    const statuses = await yunxiao.listWorkflowStatuses(issue.spaceId, issue.type);
    const targetId = yunxiao.findStatusIdByName(statuses, String(args.toStatus));
    if (!targetId) {
      const available = statuses.map((s) => s.name).join('/');
      return { success: false, output: `目标状态「${args.toStatus}」不存在。可用状态: ${available}` };
    }
    if (targetId === issue.statusId) {
      return { success: true, output: `工单 ${issue.identifier} 已处于「${args.toStatus}」状态。` };
    }
    await yunxiao.updateWorkItemStatus(issue.id, targetId);
    return { success: true, output: `已将 ${issue.identifier} 从「${issue.statusName}」流转到「${args.toStatus}」。` };
  },
};

const yunxiaoComment: AgentTool = {
  name: 'yunxiao_comment',
  description: '向云效工单追加一条评论',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '工单 ID' },
      content: { type: 'string', description: '评论内容（支持 Markdown）' },
    },
    required: ['taskId', 'content'],
  },
  async execute(args): Promise<ToolResult> {
    const issue = await yunxiao.getWorkItem(String(args.taskId));
    await yunxiao.addComment(issue.id, String(args.content));
    return { success: true, output: `已在 ${issue.identifier} 追加评论。` };
  },
};

const yunxiaoListSprints: AgentTool = {
  name: 'yunxiao_list_sprints',
  description: '列出当前项目的所有迭代（Sprint）',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    const sprints = await yunxiao.listSprints();
    if (sprints.length === 0) {
      return { success: true, output: '没有找到迭代。' };
    }
    const lines = sprints.map((s) => `${s.id}  ${s.name}  [${s.status}]`);
    return { success: true, output: `迭代列表（${sprints.length}）：\n${lines.join('\n')}` };
  },
};

const yunxiaoListMembers: AgentTool = {
  name: 'yunxiao_list_members',
  description: '列出当前项目的成员列表，可按姓名过滤',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '按姓名关键词过滤' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const members = await yunxiao.listProjectMembers(undefined, { name: args.name });
    if (members.length === 0) {
      return { success: true, output: '没有找到成员。' };
    }
    const lines = members.map((m) => `${m.id}  ${m.name}${m.role ? `  (${m.role})` : ''}`);
    return { success: true, output: `项目成员（${members.length}）：\n${lines.join('\n')}` };
  },
};

const yunxiaoSetDefaults: AgentTool = {
  name: 'yunxiao_set_defaults',
  description: '设置云效默认迭代和/或默认负责人（用于看板过滤）',
  parameters: {
    type: 'object',
    properties: {
      sprintId: { type: 'string', description: '默认迭代 ID' },
      assigneeId: { type: 'string', description: '默认负责人 ID' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const patch: Record<string, any> = {};
    if (args.sprintId !== undefined) patch.defaultSprintId = args.sprintId || undefined;
    if (args.assigneeId !== undefined) patch.defaultAssigneeId = args.assigneeId || undefined;
    setYunxiaoConfig(patch);
    const cfg = getYunxiaoConfig();
    return {
      success: true,
      output: `已更新默认设置。迭代: ${cfg.defaultSprintId ?? '(无)'}, 负责人: ${cfg.defaultAssigneeId ?? '(无)'}`,
    };
  },
};

export const yunxiaoCapability: Capability = {
  name: 'yunxiao',
  description: '云效需求缺陷管理：工单查询、详情查看、状态流转、评论、迭代/成员列表、默认设置',
  tools: [yunxiaoListTasks, yunxiaoViewTask, yunxiaoTransition, yunxiaoComment, yunxiaoListSprints, yunxiaoListMembers, yunxiaoSetDefaults],
};
