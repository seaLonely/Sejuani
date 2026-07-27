import path from 'path';
import { Capability, AgentTool, ToolResult } from '../types';
import * as yunxiao from '../../yunxiao/api';
import { transitionWorkItem, isTransitionOk } from '../../yunxiao/transitions';
import { yunxiaoConfigured } from '../../state/yunxiaoConfig';
import { getCoderConfig } from '../../state/coderConfig';
import * as git from '../../git';
import { buildFixBugSpec } from '../../workflow/fixBug';
import { buildStepContext } from '../../workflow/context';
import { runSpecInSession, renderSpecSummary } from './workflow';

/**
 * 需求/任务工作流能力模块：端到端任务自动化（开始开发、提交评审、完成任务、修复缺陷）。
 */

const taskflowStartDev: AgentTool = {
  name: 'taskflow_start_dev',
  description: '开始开发一个工单：流转状态到「开发中」并追加评论记录',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '工单 ID（如 BENZ-5650）' },
    },
    required: ['taskId'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const res = await transitionWorkItem(String(args.taskId), '开发中');
    if (!isTransitionOk(res)) {
      return { success: false, output: `流转失败：无法将 ${args.taskId} 流转到「开发中」` };
    }
    // 追加评论
    try {
      const issue = await yunxiao.getWorkItem(String(args.taskId));
      await yunxiao.addComment(issue.id, '📝 已开始开发此工单。');
    } catch { /* 评论失败不阻断 */ }
    return { success: true, output: `已将 ${args.taskId} 流转到「开发中」并记录开始开发。` };
  },
};

const taskflowSubmitReview: AgentTool = {
  name: 'taskflow_submit_review',
  description: '提交评审：流转工单到「待测试」并追加评论',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '工单 ID' },
      comment: { type: 'string', description: '可选，评论内容（如附上 MR 链接）' },
    },
    required: ['taskId'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const res = await transitionWorkItem(String(args.taskId), '待测试');
    if (!isTransitionOk(res)) {
      return { success: false, output: `流转失败：无法将 ${args.taskId} 流转到「待测试」` };
    }
    if (args.comment) {
      try {
        const issue = await yunxiao.getWorkItem(String(args.taskId));
        await yunxiao.addComment(issue.id, String(args.comment));
      } catch { /* 评论失败不阻断 */ }
    }
    return { success: true, output: `已将 ${args.taskId} 流转到「待测试」。` };
  },
};

const taskflowComplete: AgentTool = {
  name: 'taskflow_complete',
  description: '完成任务：流转工单到「已完成」',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '工单 ID' },
    },
    required: ['taskId'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const res = await transitionWorkItem(String(args.taskId), '已完成');
    if (!isTransitionOk(res)) {
      return { success: false, output: `流转失败：无法将 ${args.taskId} 流转到「已完成」` };
    }
    return { success: true, output: `已将 ${args.taskId} 流转到「已完成」。` };
  },
};

const taskflowFixBug: AgentTool = {
  name: 'taskflow_fix_bug',
  description: '端到端修复缺陷流程（会话内直接执行）：状态→开发中 → AI编码修复 → 创建MR → 评论 → 状态→待测试；危险步骤会逐一征求用户确认',
  parameters: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '缺陷工单 ID（如 BENZ-5650）' },
      repoDir: { type: 'string', description: '目标工程目录绝对路径（必填，需为 git 仓库）' },
      targetBranch: { type: 'string', description: '可选，MR 目标分支；缺省用工程当前分支' },
    },
    required: ['taskId', 'repoDir'],
  },
  needsConfirm: true,
  async execute(args, ctx): Promise<ToolResult> {
    if (!yunxiaoConfigured()) {
      return { success: false, output: '尚未配置云效 PAT/组织 id，无法执行修复流。请先执行 sjn yunxiao-config set-token/set-org。' };
    }
    const repoDir = path.resolve(String(args.repoDir));
    if (!git.isGitRepo(repoDir)) {
      return { success: false, output: `目标目录不是 git 仓库：${repoDir}` };
    }
    const issue = await yunxiao.getWorkItem(String(args.taskId));
    const coder = getCoderConfig().activeTool;
    const targetBranch = args.targetBranch
      ? String(args.targetBranch)
      : (git.currentBranch(repoDir) ?? 'master');

    const spec = buildFixBugSpec(issue, { targetBranch, domain: 'fix' });
    ctx.print(`即将执行修复流（工具: ${coder}，目标分支: ${targetBranch}）：\n${renderSpecSummary(spec)}`);

    const stepCtx = await buildStepContext(ctx.config, spec);
    stepCtx.yunxiao = { issue, repoDir, coder, targetBranch };
    return runSpecInSession(spec, stepCtx, ctx, false);
  },
};

export const taskFlowCapability: Capability = {
  name: 'taskFlow',
  description: '需求/任务工作流自动化：开始开发、提交评审、完成任务、端到端缺陷修复',
  tools: [taskflowStartDev, taskflowSubmitReview, taskflowComplete, taskflowFixBug],
};
