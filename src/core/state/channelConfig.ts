import { maskSecret } from '../../utils/secret';
import { readState, writeState, stateFilePath } from './stateFile';

/**
 * 渠道接入配置（U4）：读-合并-写回 ~/.sejuani/state.json 的 `channels` 键。
 *
 * 合规红线：仅支持飞书开放平台 + 企业微信官方 API（群机器人 webhook / 应用）。
 * 严禁个人微信号自动化（违反使用协议、封号风险）。
 */

export interface ChannelsConfig {
  feishu?: {
    /** 自定义群机器人 webhook 完整 URL */
    webhook?: string;
    /** 可选：加签密钥（飞书机器人安全设置） */
    secret?: string;
  };
  wecom?: {
    /** 企业微信群机器人 webhook 的 key（?key=xxx） */
    webhookKey?: string;
  };
}

/** 读取渠道配置（缺省空对象；webhook 支持环境变量兜底） */
export function getChannelsConfig(): ChannelsConfig {
  const raw = readState().channels;
  const c: ChannelsConfig = raw && typeof raw === 'object' ? raw : {};
  const feishuWebhook = c.feishu?.webhook || process.env.FEISHU_WEBHOOK || undefined;
  const wecomKey = c.wecom?.webhookKey || process.env.WECOM_WEBHOOK_KEY || undefined;
  return {
    feishu: { webhook: feishuWebhook, secret: c.feishu?.secret },
    wecom: { webhookKey: wecomKey },
  };
}

/** 合并写回渠道配置（浅合并 feishu/wecom 子对象） */
export function setChannelsConfig(patch: ChannelsConfig): ChannelsConfig {
  const state = readState();
  const prev: ChannelsConfig = state.channels && typeof state.channels === 'object' ? state.channels : {};
  state.channels = {
    feishu: { ...prev.feishu, ...patch.feishu },
    wecom: { ...prev.wecom, ...patch.wecom },
  };
  writeState(state);
  return getChannelsConfig();
}

/** 是否已配置指定渠道的出站能力 */
export function channelConfigured(kind: 'feishu' | 'wecom'): boolean {
  const c = getChannelsConfig();
  return kind === 'feishu' ? !!c.feishu?.webhook : !!c.wecom?.webhookKey;
}

export const maskChannelSecret = maskSecret;

export function channelStateFilePath(): string {
  return stateFilePath();
}
