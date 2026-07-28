import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

/**
 * MCP 客户端（U5）：以标准 MCP 协议（JSON-RPC 2.0 over stdio，换行分隔）连接
 * 用户配置的 MCP 服务器（如 Notion MCP）。零依赖，仅用 Node 内置 child_process。
 *
 * 关键：工具在运行时经 tools/list 发现，不硬编码任何服务器专属 schema（不臆测）。
 */

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 单请求超时（ms），默认 30s */
  timeoutMs?: number;
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = '2024-11-05';

/** 一个 MCP 会话：spawn 子进程，握手，收发 JSON-RPC，用完 close。 */
export class McpSession {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private timeoutMs: number;
  private initialized = false;

  constructor(private spec: McpServerSpec) {
    this.timeoutMs = spec.timeoutMs ?? 30000;
  }

  /** 启动子进程并完成 initialize 握手 */
  async start(): Promise<void> {
    if (this.proc) return;
    this.proc = spawn(this.spec.command, this.spec.args ?? [], {
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk));
    // stderr 必须消费：否则服务器日志写满 ~64KB 管道后子进程反压阻塞，应答发不出→请求全挂超时
    this.proc.stderr.resume();
    // stdin 异步 error（EPIPE/ERR_STREAM_DESTROYED）静默，由 exit/failAll 兼底，避免 unhandled 'error' 崩溃进程
    this.proc.stdin.on('error', () => { /* swallow: 由 exit 处理器兜底 */ });
    this.proc.on('error', (err) => this.failAll(err));
    this.proc.on('exit', (code) => {
      this.proc = null; // 后续 request 直接拒绝而非挂到超时
      this.failAll(new Error(`MCP 进程退出（code=${code}）`));
    });

    const initResult = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sejuani', version: '1.x' },
    });
    // 通知 initialized（无需响应）
    this.notify('notifications/initialized', {});
    this.initialized = true;
    void initResult;
  }

  /** 列出服务器工具（运行时发现） */
  async listTools(): Promise<McpToolDef[]> {
    const r = await this.request('tools/list', {});
    const tools = (r && Array.isArray(r.tools) ? r.tools : []) as McpToolDef[];
    return tools;
  }

  /** 调用一个工具，返回其 content（文本合并） */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string; raw: any }> {
    const r = await this.request('tools/call', { name, arguments: args ?? {} });
    const content = r && Array.isArray(r.content) ? r.content : [];
    const text = content
      .map((c: any) => (typeof c?.text === 'string' ? c.text : typeof c === 'string' ? c : JSON.stringify(c)))
      .join('\n');
    return { ok: r?.isError !== true, text, raw: r };
  }

  /** 关闭子进程 */
  close(): void {
    if (this.proc) {
      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.failAll(new Error('会话已关闭'));
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  // ---- 内部：JSON-RPC 收发（换行分隔） ----

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行（部分服务器打印日志到 stdout）忽略
      }
      if (msg && typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message || 'MCP 错误'));
        else p.resolve(msg.result);
      }
    }
  }

  private request(method: string, params: unknown): Promise<any> {
    if (!this.proc) return Promise.reject(new Error('MCP 会话未启动'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时：${method}（${Math.round(this.timeoutMs / 1000)}s）`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      /* ignore */
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/** 便捷：起一个会话跑一次操作后关闭（start 纳入 try，握手失败也确保子进程被 kill） */
export async function withMcpSession<T>(spec: McpServerSpec, fn: (s: McpSession) => Promise<T>): Promise<T> {
  const s = new McpSession(spec);
  try {
    await s.start();
    return await fn(s);
  } finally {
    s.close();
  }
}
