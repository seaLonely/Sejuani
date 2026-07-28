import { chalk } from '../../../utils/logger';
import { StepHandler } from './contract';
import { renderParams, stepsView } from '../expr';
import { getChannelsConfig } from '../../state/channelConfig';
import { sendFeishu, sendWecom } from '../../channel';

/**
 * notify.channel（U4）：把内容推送到飞书/企业微信群（官方 webhook）。
 * content 支持 {{表达式}}。作为工作流收尾把执行结果推群。
 * 合规：仅 feishu/wecom 官方 API，不支持个人微信。
 */
export const notifyChannel: StepHandler = {
  kind: 'notify.channel',
  describe: () => ({
    kind: 'notify.channel',
    summary: '把一条消息推送到飞书/企业微信群（官方群机器人）。用于工单变更/巡检结果/审批推送。',
    params: {
      kind: "必填，'feishu' | 'wecom'",
      content: '必填，消息文本；支持 {{steps.x.outputs.y}} 等表达式',
    },
    dangerous: false,
  }),
  preview: (step) => [chalk.dim(`推送到 ${step.params.kind} 群：${String(step.params.content ?? '').slice(0, 80)}`)],
  execute: async (step, ctx) => {
    const rendered = renderParams(step.params, {
      steps: stepsView(ctx.runOutputs),
      trigger: ctx.trigger,
      env: { domain: ctx.config.activeDomain },
    });
    const kind = String(rendered.kind ?? '').trim();
    const content = String(rendered.content ?? '').trim();
    if (!content) return { ok: false, reason: '缺少消息内容 content' };
    const cfg = getChannelsConfig();
    let r;
    if (kind === 'feishu') r = await sendFeishu(cfg.feishu?.webhook ?? '', content, cfg.feishu?.secret);
    else if (kind === 'wecom') r = await sendWecom(cfg.wecom?.webhookKey ?? '', content);
    else return { ok: false, reason: `不支持的渠道：${kind}（仅 feishu/wecom）` };
    return r.ok ? { ok: true, reason: `已推送到 ${kind}` } : { ok: false, reason: `推送失败：${r.error}` };
  },
};
