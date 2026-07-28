import { Capability, AgentTool, ToolResult } from '../types';
import { getChannelsConfig } from '../../state/channelConfig';
import { sendFeishu, sendWecom, ChannelKind } from '../../channel';

/**
 * 渠道推送能力（U4）：把消息发到飞书/企业微信群（官方 webhook）。
 * 对外动作，needsConfirm；无人值守走白名单授权。
 * 合规：仅飞书/企业微信官方 API，不支持个人微信。
 */

const channelSend: AgentTool = {
  name: 'channel_send',
  needsConfirm: true,
  description:
    '把一条文本消息推送到飞书或企业微信群（官方群机器人）。用于工单变更通知、巡检结果、审批提醒。仅支持 feishu/wecom，不支持个人微信。',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['feishu', 'wecom'], description: '渠道：feishu 或 wecom' },
      content: { type: 'string', description: '消息文本' },
    },
    required: ['kind', 'content'],
  },
  async execute(args): Promise<ToolResult> {
    const kind = args.kind as ChannelKind;
    const content = String(args.content ?? '').trim();
    if (!content) return { success: false, output: '消息内容为空' };
    const cfg = getChannelsConfig();
    let r;
    if (kind === 'feishu') r = await sendFeishu(cfg.feishu?.webhook ?? '', content, cfg.feishu?.secret);
    else if (kind === 'wecom') r = await sendWecom(cfg.wecom?.webhookKey ?? '', content);
    else return { success: false, output: `不支持的渠道：${kind}（仅 feishu/wecom）` };
    return r.ok ? { success: true, output: `已推送到 ${kind}` } : { success: false, output: `推送失败：${r.error}` };
  },
};

export const channelCapability: Capability = {
  name: 'channel',
  description: '渠道推送：飞书/企业微信群消息（官方 API）',
  tools: [channelSend],
};
