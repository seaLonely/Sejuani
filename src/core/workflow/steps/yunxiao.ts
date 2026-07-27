import { chalk } from '../../../utils/logger';
import * as yunxiao from '../../yunxiao/api';
import { StepHandler } from './contract';
import { requireYunxiao, renderCommentContent } from './helpers';

/** 云效类步骤：追加评论(yunxiao.comment) / 状态流转(yunxiao.transition)。 */

export const yunxiaoComment: StepHandler = {
  kind: 'yunxiao.comment',
  describe: () => ({
    kind: 'yunxiao.comment',
    summary: '向当前工单追加一条评论，记录自动化操作痕迹（支持 {mrUrl}/{branch}/{identifier} 占位符）。',
    params: {
      content: '必填，评论正文；可含占位符 {mrUrl}/{branch}/{identifier}',
    },
    dangerous: false,
    defaultRetry: { max: 2, delayMs: 3000 },
  }),
  preview: (step, ctx) => {
    const y = requireYunxiao(ctx);
    const content = renderCommentContent(String(step.params.content ?? ''), ctx);
    return [`在工单 ${y.issue.identifier} 追加评论：`, `  ${content}`];
  },
  execute: async (step, ctx) => {
    const y = requireYunxiao(ctx);
    const content = renderCommentContent(String(step.params.content ?? ''), ctx).trim();
    if (!content) return { ok: false, reason: '评论内容为空' };
    await yunxiao.addComment(y.issue.id, content);
    return { ok: true, reason: '已追加评论' };
  },
};

export const yunxiaoTransition: StepHandler = {
  kind: 'yunxiao.transition',
  describe: () => ({
    kind: 'yunxiao.transition',
    summary: '按云效工作流规则把当前工单流转到目标状态（执行前校验流转合法性）。不可逆（改变远端状态）。',
    params: {
      toStatusName: '必填，目标状态名（如 开发中/待测试/已完成）',
    },
    dangerous: true,
    defaultRetry: { max: 2, delayMs: 3000 },
  }),
  preview: (step, ctx) => {
    const y = requireYunxiao(ctx);
    return [
      chalk.yellow(`⚠ 状态流转：${y.issue.statusName || '(当前)'} → ${step.params.toStatusName ?? '<目标状态>'}`),
      `工单：${y.issue.identifier} ${y.issue.subject}`,
    ];
  },
  execute: async (step, ctx) => {
    const y = requireYunxiao(ctx);
    const toName = String(step.params.toStatusName ?? '').trim();
    if (!toName) return { ok: false, reason: '缺少目标状态名 toStatusName' };
    const statuses = y.statuses ?? (await yunxiao.listWorkflowStatuses(y.issue.spaceId, y.issue.type));
    y.statuses = statuses;
    const targetId = yunxiao.findStatusIdByName(statuses, toName);
    if (!targetId) {
      return { ok: false, reason: `目标状态「${toName}」不在该工单的工作流状态中：${statuses.map((s) => s.name).join('/') || '(空)'}` };
    }
    if (targetId === y.issue.statusId) {
      return { ok: true, reason: `已处于「${toName}」，无需流转` };
    }
    const chk = await yunxiao.canTransition(y.issue.spaceId, y.issue.type, y.issue.statusId, targetId);
    if (!chk.ok) {
      return { ok: false, reason: `不符合工作流流转规则：${y.issue.statusName} ✗→ ${toName}` };
    }
    await yunxiao.updateWorkItemStatus(y.issue.id, targetId);
    y.issue.statusId = targetId;
    y.issue.statusName = toName;
    return { ok: true, reason: `已流转到「${toName}」` };
  },
};
