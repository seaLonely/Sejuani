import { IncomingMessage, ServerResponse } from 'http';

/**
 * 极简 HTTP 路由与 JSON/SSE 工具（只用 Node 内置 http，零新增依赖）。
 * 供 sjn serve 的各 routes 模块共用。
 */

/** 请求体大小上限（1MB），防止异常大请求拖垮本地服务 */
const MAX_BODY_BYTES = 1024 * 1024;

/** 统一 JSON 响应 */
export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/** 统一错误响应：{ error: string } */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** 读取完整请求体文本；超限抛错 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大（超过 1MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 开启一个 SSE 响应流（配合 sseSend 持续写入） */
export function sseOpen(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // 先发一条注释行，让客户端立即收到响应头
  res.write(':ok\n\n');
}

/** 写一条 SSE 事件：event: <event>\ndata: <json> */
export function sseSend(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** 路由处理函数的入参 */
export interface RouteRequest {
  req: IncomingMessage;
  res: ServerResponse;
  /** 路径参数（:id 段） */
  params: Record<string, string>;
  /** 查询参数 */
  query: URLSearchParams;
  /** 解析后的 JSON 请求体（无体时为 {}） */
  body: any;
}

export type RouteHandler = (r: RouteRequest) => void | Promise<void>;

interface RouteEntry {
  method: string;
  parts: string[];
  handler: RouteHandler;
}

/**
 * 微路由：支持 /api/xxx/:id/yyy 形式的路径参数。
 * handler 抛出的异常统一转为 500 { error }（已写出响应头的 SSE 除外）。
 */
export class Router {
  private routes: RouteEntry[] = [];

  add(method: string, pattern: string, handler: RouteHandler): void {
    this.routes.push({
      method: method.toUpperCase(),
      parts: pattern.split('/').filter(Boolean),
      handler,
    });
  }

  get(pattern: string, handler: RouteHandler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): void {
    this.add('POST', pattern, handler);
  }

  /** 匹配并执行路由；未命中返回 404。 */
  async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathParts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    for (const route of this.routes) {
      if (route.method !== req.method || route.parts.length !== pathParts.length) continue;
      const params: Record<string, string> = {};
      let match = true;
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = pathParts[i];
        else if (p !== pathParts[i]) {
          match = false;
          break;
        }
      }
      if (!match) continue;

      // 按需解析 JSON 请求体（SSE/GET 无体）
      let body: any = {};
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
        const raw = await readBody(req);
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            sendError(res, 400, '请求体不是合法 JSON');
            return;
          }
        }
      }

      try {
        await route.handler({ req, res, params, query: url.searchParams, body });
      } catch (err) {
        // SSE 等已写出响应头的连接无法再改状态码，直接结束
        if (!res.headersSent) {
          sendError(res, 500, (err as Error).message ?? String(err));
        } else {
          res.end();
        }
      }
      return;
    }

    sendError(res, 404, `接口不存在: ${req.method} ${url.pathname}`);
  }
}
