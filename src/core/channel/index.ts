import https from 'https';
import http from 'http';
import crypto from 'crypto';

/**
 * 渠道客户端（U4）：出站消息推送。零依赖，仅用 Node 内置 https/http。
 *
 * 合规红线：仅飞书开放平台 + 企业微信官方 API（群机器人 webhook）。
 * 严禁个人微信号自动化。
 */

export type ChannelKind = 'feishu' | 'wecom';

export interface ChannelSendResult {
  ok: boolean;
  error?: string;
}

/** 内置 https/http 发 JSON POST，返回状态码与响应体 */
function postJson(urlStr: string, payload: string, timeoutMs = 10000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`webhook URL 非法：${urlStr}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)));
    req.write(payload);
    req.end();
  });
}

/** 飞书自定义群机器人：发文本消息（配了 secret 则加签） */
export async function sendFeishu(webhook: string, text: string, secret?: string): Promise<ChannelSendResult> {
  if (!webhook) return { ok: false, error: '未配置飞书 webhook' };
  try {
    const payload: Record<string, unknown> = { msg_type: 'text', content: { text } };
    // 飞书加签：stringToSign = `${timestamp}\n${secret}` 作为 HmacSHA256 密钥，空数据，base64
    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000);
      const sign = crypto.createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64');
      payload.timestamp = String(timestamp);
      payload.sign = sign;
    }
    const r = await postJson(webhook, JSON.stringify(payload));
    const data = JSON.parse(r.body || '{}');
    // 飞书成功严格以 code===0 为准（出错也常返回 HTTP 200 + 非零 code，不能用 status 兜底）
    if (data.code === 0 || data.StatusCode === 0) return { ok: true };
    return { ok: false, error: data.msg || data.StatusMessage || `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** 企业微信群机器人：发文本消息（webhookKey 为 ?key= 的值） */
export async function sendWecom(webhookKey: string, text: string): Promise<ChannelSendResult> {
  if (!webhookKey) return { ok: false, error: '未配置企业微信 webhookKey' };
  try {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(webhookKey)}`;
    const r = await postJson(url, JSON.stringify({ msgtype: 'text', text: { content: text } }));
    const data = JSON.parse(r.body || '{}');
    if (data.errcode === 0) return { ok: true };
    return { ok: false, error: data.errmsg || `HTTP ${r.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
