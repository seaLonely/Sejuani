import http from 'http';
import { SejuaniConfig } from '../core/config';
import { Router, sendJson, sendError } from './http';
import { EventHub } from './hub';
import { registerAgentRoutes } from './routes/agent';
import { registerDepsRoutes } from './routes/deps';
import { registerYunxiaoRoutes } from './routes/yunxiao';
import { registerWorkflowRoutes } from './routes/workflows';
import { registerHookRoutes } from './routes/hooks';
import { registerBatchRoutes } from './routes/batch';
import { registerConfigRoutes } from './routes/config';
import { readPkgVersion } from '../utils/pkgVersion';

/**
 * 本地 HTTP API 服务（sjn serve）：供 Tauri 桌面前端调用。
 * 只用 Node 内置 http 模块，零新增依赖；直接复用 core 能力。
 * 绑定 127.0.0.1，仅允许本机 localhost / Tauri webview 的跨域来源。
 */

export interface ServeOptions {
  /** 监听端口，默认 7758 */
  port?: number;
  /** 已按当前域展开的配置 */
  config: SejuaniConfig;
}

/** 允许的跨域来源：http://localhost:任意端口、tauri://localhost、https://tauri.localhost */
function allowedOrigin(origin?: string): string | null {
  if (!origin) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  if (origin === 'tauri://localhost' || origin === 'https://tauri.localhost') return origin;
  return null;
}

/** 启动服务，监听成功后返回 server 实例 */
export async function startServer(opts: ServeOptions): Promise<http.Server> {
  const port = opts.port ?? 7758;
  const router = new Router();
  const hub = new EventHub();

  router.get('/api/health', (r) => {
    sendJson(r.res, 200, { ok: true, version: readPkgVersion() });
  });
  registerAgentRoutes(router, hub, opts.config);
  registerDepsRoutes(router, opts.config);
  registerYunxiaoRoutes(router);
  registerWorkflowRoutes(router, hub, opts.config);
  registerHookRoutes(router, opts.config);
  registerBatchRoutes(router, opts.config);
  registerConfigRoutes(router);

  const server = http.createServer((req, res) => {
    // CORS：仅对本机/Tauri 来源回显 origin；其它来源不带 CORS 头（浏览器会拦截）
    const origin = allowedOrigin(req.headers.origin);
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    router.dispatch(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, 500, (err as Error).message ?? String(err));
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
