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
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** tool 角色时必填：对应的 tool_call id */
  tool_call_id?: string;
  /** assistant 角色时可能携带 tool_calls */
  tool_calls?: ToolCall[];
}

// ──── Function Calling 支持 ────

/** OpenAI function calling 的工具函数定义 */
export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, any>; // JSON Schema
}

/** LLM 返回的工具调用请求 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatToolsOptions {
  model?: string;
  temperature?: number;
  timeoutMs?: number;
  tools: ToolFunction[];
}

export interface ChatToolsResult {
  /** 直接文本回复（无需调用工具时） */
  content?: string;
  /** 需要执行的工具调用 */
  toolCalls?: ToolCall[];
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

/**
 * 发起一次带 Function Calling 的 chat completions 请求。
 * LLM 可选择返回文本内容（直接回复）或 tool_calls（需调用方执行后回传结果）。
 */
export async function chatWithTools(
  messages: ChatMessage[],
  opts: ChatToolsOptions
): Promise<ChatToolsResult> {
  const cfg = getAiConfig();
  if (!cfg.apiKey) {
    throw new Error('未配置 AI apiKey。请先执行 `sjn ai-config set-key <key>`（或设置环境变量 OPENAI_API_KEY）。');
  }

  // 构造 OpenAI tools 格式
  const tools = opts.tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const payload = JSON.stringify({
    model: opts.model ?? cfg.model,
    temperature: opts.temperature ?? cfg.temperature,
    messages: messages.map(serializeMessage),
    tools,
  });

  const url = completionsUrl(cfg.baseURL);
  logEvent('debug', 'ai.toolRequest', { url, model: opts.model ?? cfg.model, toolCount: tools.length });

  let res: HttpJsonResult;
  try {
    res = await postJson(
      url,
      { Authorization: `Bearer ${cfg.apiKey}` },
      payload,
      opts.timeoutMs ?? 120000
    );
  } catch (err) {
    logEvent('error', 'ai.error', { url, reason: (err as Error).message });
    throw new Error(`AI 请求失败: ${(err as Error).message}`);
  }

  logEvent('debug', 'ai.toolResponse', { status: res.status, body: res.body.slice(0, 2000) });

  if (res.status < 200 || res.status >= 300) {
    let detail = res.body;
    try {
      const parsed = JSON.parse(res.body);
      detail = parsed?.error?.message ?? res.body;
    } catch { /* keep raw */ }
    throw new Error(`AI 接口返回 HTTP ${res.status}: ${String(detail).slice(0, 500)}`);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error(`AI 响应体不是合法 JSON：\n${res.body.slice(0, 500)}`);
  }

  const choice = parsed?.choices?.[0];
  if (!choice) throw new Error('AI 响应缺少 choices[0]。');

  const msg = choice.message;
  const finishReason = choice.finish_reason;

  // 模型选择调用工具
  if (finishReason === 'tool_calls' || (msg?.tool_calls && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0)) {
    const rawCalls = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    if (rawCalls.length === 0) {
      // finish_reason 声称 tool_calls 但实际为空，回退为文本响应
      return { content: msg?.content ?? '' };
    }
    const toolCalls: ToolCall[] = rawCalls.map((tc: any) => ({
      id: tc.id ?? '',
      type: 'function' as const,
      function: {
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '{}',
      },
    }));
    return { toolCalls };
  }

  // 模型直接回复文本
  const content = msg?.content ?? '';
  return { content: typeof content === 'string' ? content : JSON.stringify(content) };
}

/** 序列化 ChatMessage 为 API 格式（处理 tool 角色的特殊字段）。 */
function serializeMessage(m: ChatMessage): Record<string, any> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.tool_call_id };
  }
  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    return { role: 'assistant', content: m.content || null, tool_calls: m.tool_calls };
  }
  return { role: m.role, content: m.content };
}
