// 与 `sjn serve` 本地服务通信的封装。
// 后端未就绪时所有请求抛出 ApiError，页面据此展示「后端未连接」态。

export const API_BASE = 'http://127.0.0.1:7758';

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  } catch {
    throw new ApiError('后端未连接');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(`请求失败（${res.status}）${text ? `：${text.slice(0, 200)}` : ''}`);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
};

// 订阅 SSE。同时监听默认 message 与后端可能使用的命名事件，
// 回调收到解析后的 JSON data 与事件名。
export function subscribe(
  path: string,
  onEvent: (data: unknown, event: string) => void,
  onError?: () => void,
): () => void {
  const es = new EventSource(`${API_BASE}${path}`);
  const handler = (ev: MessageEvent) => {
    try {
      onEvent(JSON.parse(ev.data), ev.type);
    } catch {
      // 非 JSON 行（如注释/心跳），忽略
    }
  };
  es.onmessage = handler;
  for (const name of ['tool', 'confirm', 'log', 'step', 'event']) {
    es.addEventListener(name, handler as EventListener);
  }
  if (onError) es.onerror = onError;
  return () => es.close();
}

// 宽松字段读取：后端个别接口字段名可能微调，按候选路径逐个取值。
export function pick(obj: unknown, paths: string[]): unknown {
  if (obj == null || typeof obj !== 'object') return undefined;
  for (const p of paths) {
    const v = p.split('.').reduce<unknown>((o, key) => {
      if (o == null || typeof o !== 'object') return undefined;
      return (o as Record<string, unknown>)[key];
    }, obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function pickText(obj: unknown, paths: string[]): string {
  const v = pick(obj, paths);
  if (v == null) return '';
  if (typeof v === 'object') {
    const name = pick(v, ['name', 'label', 'title', 'id']);
    return name != null ? String(name) : JSON.stringify(v);
  }
  return String(v);
}
