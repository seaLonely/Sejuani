import http from 'http';
import https from 'https';
import { URL } from 'url';
import { getYunxiaoConfig } from '../state/yunxiaoConfig';
import { logEvent } from '../../utils/fileLogger';

/**
 * 极简云效 OpenAPI 客户端：只用 Node 内置 https/http（与 aiClient 同风格，
 * 不引入 axios 等外部依赖，保持零新增依赖）。
 *
 * 统一注入鉴权头 x-yunxiao-token: <PAT>，做查询串拼接与 4xx/5xx 错误映射，
 * 返回解析后的 JSON。上层 api.ts 只关心业务字段。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  /** 查询参数（会做 URL 编码后拼到 path 上） */
  query?: Record<string, string | number | boolean | undefined>;
  /** 请求体（对象会 JSON 序列化） */
  body?: unknown;
  /** 超时(ms)，默认 30000 */
  timeoutMs?: number;
}

interface HttpResult {
  status: number;
  body: string;
}

/** 把 query 对象拼成 ?a=1&b=2（忽略 undefined）。 */
function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** 发一次带鉴权头的 HTTP 请求，返回状态码与原始响应体。 */
function sendRequest(
  urlStr: string,
  method: HttpMethod,
  token: string,
  payload: string | null,
  timeoutMs: number
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`云效请求地址非法: ${urlStr}`));
      return;
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-yunxiao-token': token,
    };
    if (payload !== null) headers['Content-Length'] = String(Buffer.byteLength(payload));
    const req = lib.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`云效请求超时（${Math.round(timeoutMs / 1000)}s）`));
    });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** 从错误响应体里尽量抽取可读信息。 */
function extractErrorMessage(status: number, body: string): string {
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    detail = parsed?.errorMessage ?? parsed?.message ?? parsed?.error?.message ?? body;
  } catch {
    /* 保留原始 body */
  }
  const hint =
    status === 401 || status === 403
      ? '（令牌无效或无权限，请检查 sjn yunxiao-config set-token）'
      : status === 404
        ? '（资源不存在，请检查组织 id / 工单 id）'
        : status === 429
          ? '（触发限流，请稍后重试）'
          : '';
  return `云效接口 HTTP ${status}${hint}: ${String(detail).slice(0, 500)}`;
}

/**
 * 发起一次云效 OpenAPI 请求并解析 JSON 返回。
 * path 以 '/' 开头（不含协议与域名），域名/令牌从配置读取。
 * 失败时抛出带清晰信息的 Error（鉴权/超时/HTTP 错误/解析失败）。
 */
export async function request<T = any>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
  const cfg = getYunxiaoConfig();
  if (!cfg.personalAccessToken) {
    throw new Error('未配置云效令牌。请先执行 `sjn yunxiao-config set-token <token>`（或设置环境变量 YUNXIAO_TOKEN）。');
  }
  if (!cfg.organizationId) {
    throw new Error('未配置云效组织 id。请先执行 `sjn yunxiao-config set-org <id>`（或设置环境变量 YUNXIAO_ORG_ID）。');
  }
  const base = /^https?:\/\//.test(cfg.endpoint) ? cfg.endpoint : `https://${cfg.endpoint}`;
  const url = `${base.replace(/\/+$/, '')}${path}${buildQuery(opts.query)}`;
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : null;

  logEvent('debug', 'yunxiao.request', { method, url, hasBody: payload !== null });
  let res: HttpResult;
  try {
    res = await sendRequest(url, method, cfg.personalAccessToken, payload, opts.timeoutMs ?? 30000);
  } catch (err) {
    logEvent('error', 'yunxiao.error', { method, url, reason: (err as Error).message });
    throw new Error(`云效请求失败: ${(err as Error).message}`);
  }
  logEvent('debug', 'yunxiao.response', { method, url, status: res.status, body: res.body.slice(0, 2000) });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(extractErrorMessage(res.status, res.body));
  }
  // 204 或空体：返回空对象
  if (!res.body.trim()) return {} as T;
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`云效响应体不是合法 JSON：\n${res.body.slice(0, 500)}`);
  }
}

/** 当前组织 id（供 api 层拼路径用）。 */
export function organizationId(): string {
  return getYunxiaoConfig().organizationId;
}
