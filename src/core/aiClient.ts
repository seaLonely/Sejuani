import http from 'http';
import https from 'https';
import { URL } from 'url';
import { getAiConfig } from './aiConfig';
import { logEvent } from '../utils/fileLogger';

/**
 * 极简 OpenAI(兼容) chat completions 客户端：只用 Node 内置 https/http，
 * 不引入 openai SDK（其 v4 需要 Node 18+，本 CLI 跑在 Node 16）。
 *
 * chatJSON 要求模型返回一个 JSON 对象（response_format=json_object），
 * 并对返回内容做容错解析（剥离 ```json 代码块 / 提取首个 {...}）。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatJSONOptions {
  /** 覆盖配置里的模型 */
  model?: string;
  /** 覆盖配置里的温度 */
  temperature?: number;
  /** 请求超时(ms)，默认 60000 */
  timeoutMs?: number;
}

/** 拼接 chat completions 的完整 URL（兼容 baseURL 末尾是否带 /v1、是否带斜杠） */
function completionsUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, '');
  return `${trimmed}/chat/completions`;
}

interface HttpJsonResult {
  status: number;
  body: string;
}

/** 用内置 https/http 发一个 JSON POST，返回状态码与原始响应体。 */
function postJson(
  urlStr: string,
  headers: Record<string, string>,
  payload: string,
  timeoutMs: number
): Promise<HttpJsonResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      reject(new Error(`AI baseURL 非法，无法构造请求地址: ${urlStr}`));
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
          ...headers,
        },
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
      req.destroy(new Error(`AI 请求超时（${Math.round(timeoutMs / 1000)}s）`));
    });
    req.write(payload);
    req.end();
  });
}

/**
 * 从任意文本中容错提取一个 JSON 对象：
 * 1) 先尝试整体 JSON.parse；
 * 2) 剥离 ```json ... ``` 代码块围栏后再试；
 * 3) 截取首个 { 到末个 } 的子串再试。
 * 均失败则抛错。
 */
export function extractJsonObject(text: string): any {
  const tryParse = (s: string): any | undefined => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fenced = text.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '');
  const fromFence = tryParse(fenced.trim());
  if (fromFence !== undefined) return fromFence;

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = text.slice(start, end + 1);
    const fromSlice = tryParse(slice);
    if (fromSlice !== undefined) return fromSlice;
  }
  throw new Error(`AI 返回内容无法解析为 JSON：\n${text.slice(0, 800)}`);
}

/**
 * 发起一次 chat completions 请求，要求模型返回 JSON 对象并解析返回。
 * 失败时抛出带清晰信息的 Error（鉴权/超时/HTTP 错误/解析失败）。
 */
export async function chatJSON(messages: ChatMessage[], opts: ChatJSONOptions = {}): Promise<any> {
  const cfg = getAiConfig();
  if (!cfg.apiKey) {
    throw new Error('未配置 AI apiKey。请先执行 `sjn ai config set-key <key>`（或设置环境变量 OPENAI_API_KEY）。');
  }
  const payload = JSON.stringify({
    model: opts.model ?? cfg.model,
    temperature: opts.temperature ?? cfg.temperature,
    messages,
    response_format: { type: 'json_object' },
  });

  const url = completionsUrl(cfg.baseURL);
  // 记录完整请求（messages 原文），apiKey 绝不入日志（仅在 header，不记录 header）
  logEvent('debug', 'ai.request', {
    url,
    model: opts.model ?? cfg.model,
    temperature: opts.temperature ?? cfg.temperature,
    messages,
  });
  let res: HttpJsonResult;
  try {
    res = await postJson(
      url,
      { Authorization: `Bearer ${cfg.apiKey}` },
      payload,
      opts.timeoutMs ?? 60000
    );
  } catch (err) {
    logEvent('error', 'ai.error', { url, reason: (err as Error).message });
    throw new Error(`AI 请求失败: ${(err as Error).message}`);
  }

  // 记录响应原文（盲盒终结点）
  logEvent('debug', 'ai.response', { status: res.status, body: res.body });

  if (res.status < 200 || res.status >= 300) {
    let detail = res.body;
    try {
      const parsed = JSON.parse(res.body);
      detail = parsed?.error?.message ?? res.body;
    } catch {
      /* 保留原始 body */
    }
    throw new Error(`AI 接口返回 HTTP ${res.status}: ${String(detail).slice(0, 500)}`);
  }

  let content: string | undefined;
  try {
    const parsed = JSON.parse(res.body);
    content = parsed?.choices?.[0]?.message?.content;
  } catch {
    throw new Error(`AI 响应体不是合法 JSON：\n${res.body.slice(0, 500)}`);
  }
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('AI 响应缺少 choices[0].message.content。');
  }
  return extractJsonObject(content);
}
