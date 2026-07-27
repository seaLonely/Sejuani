import { chalk, logger } from '../../../utils/logger';
import { StepContext, WorkflowStep } from '../types';
import { StepHandler, StepExecResult } from './contract';
import { renderParams, evalPath, ExprContext, stepsView } from '../expr';
import { STEP_HANDLERS } from './index';

/**
 * 流程控制步骤（W3）：
 * - flow.foreach：对表达式取出的列表逐项串行执行内嵌子步骤模板；
 * - flow.wait：延时/等 webhook 挂起（suspend 落盘，由调度器/hooks 唤醒），
 *   untilConfirm 场景约定给步骤声明 dangerous:true（确认由 engine 危险流程完成）。
 */

/** 构造迭代项的表达式上下文 */
function itemCtx(ctx: StepContext, item: unknown): ExprContext {
  return {
    steps: stepsView(ctx.runOutputs),
    trigger: ctx.trigger,
    env: { domain: ctx.config.activeDomain },
    item,
  };
}

export const flowForeach: StepHandler = {
  kind: 'flow.foreach',
  describe: () => ({
    kind: 'flow.foreach',
    summary: '对列表逐项串行执行内嵌子步骤（子步骤 params 中可用 {{item}}/{{item.<field>}}），产物聚合为 results。',
    params: {
      items: '必填，取列表的表达式（如 {{steps.s1.outputs.foundProjects}}）或字面数组',
      subSteps: '必填，子步骤模板数组 [{ kind, title, params }]（禁止嵌套 flow.foreach）',
      onItemError: "可选，'stop'(默认)|'continue'：单项失败是否继续后续项",
    },
    dangerous: false,
  }),
  preview: (step) => {
    const count = Array.isArray(step.params.subSteps) ? step.params.subSteps.length : 0;
    return [`对列表 ${String(step.params.items ?? '')} 逐项执行 ${count} 个子步骤`];
  },
  execute: async (step, ctx) => {
    // items：字面数组或表达式取值
    let items: unknown[];
    if (Array.isArray(step.params.items)) {
      items = step.params.items;
    } else {
      const raw = String(step.params.items ?? '').trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
      const value = evalPath(raw, itemCtx(ctx, undefined));
      if (!Array.isArray(value)) {
        return { ok: false, reason: `items 未取到列表：${step.params.items}` };
      }
      items = value;
    }
    const subSteps = Array.isArray(step.params.subSteps) ? (step.params.subSteps as WorkflowStep[]) : [];
    if (subSteps.length === 0) return { ok: false, reason: '缺少子步骤 subSteps' };
    if (subSteps.some((s) => s.kind === 'flow.foreach')) {
      return { ok: false, reason: '不支持嵌套 flow.foreach' };
    }
    // 安全闸：子步骤不经过引擎的危险确认/批准队列，因此一律禁止危险子步骤
    //（kind 默认危险或显式 dangerous:true），危险操作必须作为顶层步骤声明。
    const dangerousSub = subSteps.find(
      (s) => s.dangerous || (STEP_HANDLERS[s.kind]?.describe().dangerous ?? false)
    );
    if (dangerousSub) {
      return {
        ok: false,
        reason: `子步骤含危险操作（${dangerousSub.kind}），禁止在 flow.foreach 内执行；请改为顶层步骤以经过危险确认/批准流程`,
      };
    }
    const onItemError = step.params.onItemError === 'continue' ? 'continue' : 'stop';

    const results: Array<{ item: unknown; ok: boolean; reason?: string }> = [];
    let idx = 0;
    for (const item of items) {
      idx++;
      logger.step(`  [foreach ${idx}/${items.length}] ${typeof item === 'string' ? item : JSON.stringify(item).slice(0, 60)}`);
      let itemOk = true;
      let itemReason: string | undefined;
      for (const sub of subSteps) {
        const handler = STEP_HANDLERS[sub.kind];
        if (!handler) {
          itemOk = false;
          itemReason = `未知子步骤 kind: ${sub.kind}`;
          break;
        }
        const rendered: WorkflowStep = {
          id: `${step.id}.${sub.id ?? sub.kind}.${idx}`,
          kind: sub.kind,
          title: sub.title ?? sub.kind,
          params: renderParams(sub.params ?? {}, itemCtx(ctx, item)),
        };
        try {
          const r: StepExecResult = await handler.execute(rendered, ctx);
          if (!r.ok) {
            itemOk = false;
            itemReason = r.reason;
            break;
          }
        } catch (err) {
          itemOk = false;
          itemReason = (err as Error).message;
          break;
        }
      }
      results.push({ item, ok: itemOk, reason: itemReason });
      if (!itemOk && onItemError === 'stop') {
        return {
          ok: false,
          reason: `第 ${idx} 项失败：${itemReason ?? '未知原因'}`,
          outputs: { results },
        };
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    return {
      ok: failed === 0 || onItemError === 'continue',
      reason: `共 ${items.length} 项，失败 ${failed} 项`,
      outputs: { results },
    };
  },
};

export const flowWait: StepHandler = {
  kind: 'flow.wait',
  describe: () => ({
    kind: 'flow.wait',
    summary:
      '等待节点：forSeconds=延时挂起（调度器到时唤醒续跑）；untilWebhook=等 POST /api/hooks/<path> 唤醒；untilConfirm=需人工确认后继续（约定该步声明 dangerous:true，由引擎确认流程实现）。',
    params: {
      forSeconds: '可选，延时秒数（与其它两项三选一）',
      untilWebhook: '可选，等待唤醒的 webhook 路径',
      untilConfirm: '可选，true=等待人工确认（配合 dangerous:true）',
    },
    dangerous: false,
  }),
  preview: (step) => {
    if (step.params.forSeconds) return [chalk.dim(`等待 ${step.params.forSeconds}s 后继续（挂起落盘，由调度器唤醒）`)];
    if (step.params.untilWebhook) return [chalk.dim(`等待 webhook 唤醒：POST /api/hooks/${step.params.untilWebhook}`)];
    return [chalk.dim('等待人工确认后继续')];
  },
  execute: async (step) => {
    const forSeconds = Number(step.params.forSeconds);
    if (Number.isFinite(forSeconds) && forSeconds > 0) {
      const wakeAt = new Date(Date.now() + forSeconds * 1000).toISOString();
      return { ok: true, reason: `已安排等待 ${forSeconds}s`, outputs: { wakeAt }, suspend: { wakeAt } };
    }
    const hook = step.params.untilWebhook ? String(step.params.untilWebhook).trim() : '';
    if (hook) {
      return { ok: true, reason: `等待 webhook: ${hook}`, outputs: { wakeWebhook: hook }, suspend: { wakeWebhook: hook } };
    }
    if (step.params.untilConfirm) {
      // 确认已由 engine 危险步骤流程完成（约定本步声明 dangerous:true）
      return { ok: true, reason: '人工确认通过' };
    }
    return { ok: false, reason: 'flow.wait 需要 forSeconds / untilWebhook / untilConfirm 之一' };
  },
};
