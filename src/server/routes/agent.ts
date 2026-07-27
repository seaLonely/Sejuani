import { randomUUID } from 'crypto';
import { Router, sendJson, sendError } from '../http';
import { EventHub } from '../hub';
import { SejuaniConfig } from '../../core/config';
import { aiConfigured } from '../../core/state/aiConfig';
import { AgentBrain } from '../../core/agent/brain';
import { AgentHarness } from '../../core/agent/harness';
import { getAllTools } from '../../core/agent/registry';
import { listSessions, loadSession } from '../../core/agent/sessionStore';

/**
 * Agent 对话路由：会话管理 + SSE 事件推送 + 危险操作确认/输入桥。
 *
 * - POST /api/agent/session            创建会话（可传 resumeId 从磁盘恢复历史）
 * - GET  /api/agent/sessions           会话列表（内存 + 磁盘合并）
 * - GET  /api/agent/sessions/:id/stats 会话统计（轮次/工具调用/token）
 * - POST /api/agent/chat               发起一轮对话（token 级增量经 SSE delta 事件推送）
 * - POST /api/agent/abort              中断当前轮
 * - GET  /api/agent/events             SSE 订阅会话事件（print/delta/confirm/input-request/done/error/aborted）
 * - POST /api/agent/confirm            应答危险操作确认 { id, ok, always? }
 * - POST /api/agent/input              应答文本输入请求 { id, value }
 * - GET  /api/agent/tools              已注册工具清单
 *
 * 会话为内存 Map + 磁盘持久化（sessionStore）；2 小时无活动的内存会话被清理，
 * 可用 resumeId 从磁盘恢复。
 */

/** 内存会话空闲清理阈值（2 小时） */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

interface Session {
  id: string;
  brain: AgentBrain;
  /** 是否正在处理一轮对话（同会话串行，避免 history 交错） */
  busy: boolean;
  createdAt: string;
  lastActiveAt: number;
}

const sessions = new Map<string, Session>();

/** 会话对应的 SSE 频道名 */
function channelOf(sessionId: string): string {
  return `agent:${sessionId}`;
}

/** 去掉 core 输出里的 ANSI 颜色码（brain/工具内部用 chalk 上色） */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** 创建并装配一个会话（注入 SSE 桥），可选从磁盘恢复历史 */
function createSession(config: SejuaniConfig, hub: EventHub, resumeId?: string): Session {
  const id = resumeId ?? `s_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const brain = new AgentBrain(config, { sessionId: id, resume: !!resumeId });
  brain.setPrint((text) => {
    hub.publish(channelOf(id), 'print', { text: stripAnsi(text) });
  });
  brain.setConfirm((message) => hub.ask(channelOf(id), stripAnsi(message)));
  brain.setConfirmEx((message) => hub.askEx(channelOf(id), stripAnsi(message)));
  brain.setPromptInput((message) => hub.askInput(channelOf(id), stripAnsi(message)));
  const session: Session = { id, brain, busy: false, createdAt: new Date().toISOString(), lastActiveAt: Date.now() };
  sessions.set(id, session);
  return session;
}

/** 定期清理空闲会话（unref 不阻止进程退出） */
const cleaner = setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (!s.busy && now - s.lastActiveAt > SESSION_TTL_MS) sessions.delete(id);
  }
}, 10 * 60 * 1000);
cleaner.unref();

export function registerAgentRoutes(router: Router, hub: EventHub, config: SejuaniConfig): void {
  // 创建会话（resumeId：从 sessionStore 恢复历史与统计）
  router.post('/api/agent/session', (r) => {
    const { resumeId } = r.body ?? {};
    if (resumeId !== undefined && (typeof resumeId !== 'string' || !loadSession(String(resumeId)))) {
      sendError(r.res, 404, `持久化会话不存在: ${resumeId}（GET /api/agent/sessions 查看）`);
      return;
    }
    const session = createSession(config, hub, resumeId ? String(resumeId) : undefined);
    sendJson(r.res, 200, {
      sessionId: session.id,
      tools: session.brain.getToolCount(),
      aiConfigured: aiConfigured(),
      resumed: !!resumeId,
    });
  });

  // 会话列表（内存 + 磁盘合并去重）
  router.get('/api/agent/sessions', (r) => {
    const persisted = listSessions();
    const memoryIds = new Set(sessions.keys());
    const items = [
      ...[...sessions.values()].map((s) => ({
        id: s.id,
        createdAt: s.createdAt,
        active: true,
        busy: s.busy,
      })),
      ...persisted
        .filter((p) => !memoryIds.has(p.id))
        .map((p) => ({ id: p.id, createdAt: p.createdAt, updatedAt: p.updatedAt, active: false, busy: false })),
    ];
    sendJson(r.res, 200, items);
  });

  // 会话统计（轮次/工具调用/token 用量）
  router.get('/api/agent/sessions/:id/stats', (r) => {
    const mem = sessions.get(r.params.id);
    if (mem) {
      sendJson(r.res, 200, mem.brain.getStats());
      return;
    }
    const rec = loadSession(r.params.id);
    if (rec?.stats) {
      sendJson(r.res, 200, rec.stats);
      return;
    }
    sendError(r.res, 404, `会话不存在或无统计: ${r.params.id}`);
  });

  // SSE 事件流（需在 chat 前订阅，才能收到 print/delta/confirm 等事件）
  router.get('/api/agent/events', (r) => {
    const sessionId = r.query.get('sessionId') ?? '';
    if (!sessions.has(sessionId)) {
      sendError(r.res, 404, `会话不存在: ${sessionId}（先 POST /api/agent/session 创建）`);
      return;
    }
    hub.subscribe(channelOf(sessionId), r.res);
  });

  // 发起一轮对话（token 级增量经 SSE delta 事件推送；HTTP 响应仍一次性返回完整 reply）
  router.post('/api/agent/chat', async (r) => {
    const { sessionId, input } = r.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) {
      sendError(r.res, 404, `会话不存在: ${sessionId}（先 POST /api/agent/session 创建）`);
      return;
    }
    if (typeof input !== 'string' || !input.trim()) {
      sendError(r.res, 400, 'input 不能为空');
      return;
    }
    if (session.busy) {
      sendError(r.res, 409, '该会话正在处理上一轮对话，请等待完成后再发送。');
      return;
    }
    if (!aiConfigured()) {
      sendError(r.res, 400, '尚未配置 AI apiKey。请先执行 `sjn ai-config set-key <key>`（或设置环境变量 OPENAI_API_KEY）。');
      return;
    }

    session.busy = true;
    session.lastActiveAt = Date.now();
    try {
      const reply = await session.brain.process(input.trim(), {
        onDelta: (text) => hub.publish(channelOf(session.id), 'delta', { text }),
      });
      hub.publish(channelOf(session.id), 'done', { reply });
      sendJson(r.res, 200, { reply });
    } catch (err) {
      const msg = (err as Error).message;
      hub.publish(channelOf(session.id), 'error', { error: msg });
      sendError(r.res, 500, msg);
    } finally {
      session.busy = false;
      session.lastActiveAt = Date.now();
    }
  });

  // 自主目标模式（H1）：Harness.runGoal 跑到终局，进度经 SSE harness 事件推送
  router.post('/api/agent/goal', async (r) => {
    const { sessionId, goal, budget } = r.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) {
      sendError(r.res, 404, `会话不存在: ${sessionId}（先 POST /api/agent/session 创建）`);
      return;
    }
    if (typeof goal !== 'string' || !goal.trim()) {
      sendError(r.res, 400, 'goal 不能为空');
      return;
    }
    if (session.busy) {
      sendError(r.res, 409, '该会话正在处理中，请等待完成。');
      return;
    }
    if (!aiConfigured()) {
      sendError(r.res, 400, '尚未配置 AI apiKey。');
      return;
    }
    session.busy = true;
    session.lastActiveAt = Date.now();
    const ch = channelOf(session.id);
    const harness = AgentHarness.fromBrain(session.brain, {
      budget: budget && typeof budget === 'object' ? budget : undefined,
      memoryDomain: config.activeDomain,
      reportId: session.id,
      onDelta: (text) => hub.publish(ch, 'delta', { text }),
      onProgress: (e) => hub.publish(ch, 'harness-progress', e),
    });
    try {
      const result = await harness.runGoal(goal.trim());
      hub.publish(ch, 'harness-finish', result);
      sendJson(r.res, 200, result);
    } catch (err) {
      const msg = (err as Error).message;
      hub.publish(ch, 'error', { error: msg });
      sendError(r.res, 500, msg);
    } finally {
      session.busy = false;
      session.lastActiveAt = Date.now();
    }
  });

  // 中断当前轮（busy 时生效）
  router.post('/api/agent/abort', (r) => {
    const { sessionId } = r.body ?? {};
    const session = sessions.get(String(sessionId ?? ''));
    if (!session) {
      sendError(r.res, 404, `会话不存在: ${sessionId}`);
      return;
    }
    if (!session.busy) {
      sendJson(r.res, 200, { ok: true, aborted: false, message: '当前没有进行中的对话轮次。' });
      return;
    }
    session.brain.abort();
    hub.publish(channelOf(session.id), 'aborted', {});
    sendJson(r.res, 200, { ok: true, aborted: true });
  });

  // 应答危险操作确认（always=true 表示本会话内同名工具不再询问）
  router.post('/api/agent/confirm', (r) => {
    const { sessionId, id, ok, always } = r.body ?? {};
    if (sessionId !== undefined && !sessions.has(String(sessionId))) {
      sendError(r.res, 404, `会话不存在: ${sessionId}`);
      return;
    }
    if (!id) {
      sendError(r.res, 400, '缺少确认请求 id');
      return;
    }
    if (!hub.answer(String(id), !!ok, !!always)) {
      sendError(r.res, 404, `确认请求不存在或已超时: ${id}`);
      return;
    }
    sendJson(r.res, 200, { ok: true });
  });

  // 应答文本输入请求（工作流 needsInput 补全）
  router.post('/api/agent/input', (r) => {
    const { sessionId, id, value } = r.body ?? {};
    if (sessionId !== undefined && !sessions.has(String(sessionId))) {
      sendError(r.res, 404, `会话不存在: ${sessionId}`);
      return;
    }
    if (!id) {
      sendError(r.res, 400, '缺少输入请求 id');
      return;
    }
    if (!hub.answerInput(String(id), typeof value === 'string' ? value : '')) {
      sendError(r.res, 404, `输入请求不存在或已超时: ${id}`);
      return;
    }
    sendJson(r.res, 200, { ok: true });
  });

  // 工具清单（供前端展示）
  router.get('/api/agent/tools', (r) => {
    sendJson(
      r.res,
      200,
      getAllTools().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        needsConfirm: !!t.needsConfirm,
        readOnly: !!t.readOnly,
      }))
    );
  });
}
