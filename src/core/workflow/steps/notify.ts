import { logger } from '../../../utils/logger';
import * as yunxiao from '../../yunxiao/api';
import { StepHandler } from './contract';
import { renderCommentContent } from './helpers';

/**
 * 汇总步骤：把本次运行各步骤产物（ctx.runOutputs）渲染为文本输出，
 * 可选追加为云效工单评论（需处于修复流上下文）。
 */

/** 把 runOutputs 渲染为多行文本（无产物时返回提示行） */
function renderSummary(ctx: { runOutputs?: Record<string, Record<string, unknown>> }): string[] {
  const entries = Object.entries(ctx.runOutputs ?? {});
  if (entries.length === 0) return ['（本次运行暂无步骤产物）'];
  const lines: string[] = [];
  for (const [stepId, outputs] of entries) {
    for (const [key, value] of Object.entries(outputs)) {
      const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
      if (text.trim()) lines.push(`${stepId}.${key}: ${text.slice(0, 300)}`);
    }
  }
  return lines.length > 0 ? lines : ['（本次运行暂无步骤产物）'];
}

export const notifySummary: StepHandler = {
  kind: 'notify.summary',
  describe: () => ({
    kind: 'notify.summary',
    summary: '汇总本次运行各步骤的产物（如 MR 链接、命中工程）并输出；可选追加为云效工单评论。',
    params: {
      toComment: '可选，boolean；true=同时把汇总追加为当前工单评论（需处于修复流上下文）',
    },
    dangerous: false,
  }),
  preview: (step, ctx) => {
    const target = step.params.toComment && ctx.yunxiao ? '（并评论到工单）' : '';
    return [`汇总本次运行的步骤产物${target}`];
  },
  execute: async (step, ctx) => {
    const lines = renderSummary(ctx);
    logger.title('运行产物汇总');
    for (const l of lines) logger.info('  ' + l);
    if (step.params.toComment && ctx.yunxiao) {
      const content = renderCommentContent(
        `📋 Sejuani 运行汇总：\n${lines.join('\n')}`,
        ctx
      );
      await yunxiao.addComment(ctx.yunxiao.issue.id, content);
      return { ok: true, reason: `已汇总 ${lines.length} 条产物并评论到工单` };
    }
    return { ok: true, reason: `已汇总 ${lines.length} 条产物` };
  },
};
