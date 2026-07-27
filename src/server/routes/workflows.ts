import fs from 'fs';
import { Router, sendJson, sendError, sseOpen, sseSend } from '../http';
import { EventHub } from '../hub';
import { SejuaniConfig } from '../../core/config';
import { listSpecs, loadSpec, loadRunState, saveSpec, listExecutions, loadExecution, listExecutionsByStatus, findExecution, saveExecution } from '../../core/workflow/store';
import { runWorkflow } from '../../core/workflow/engine';
import { buildStepContext } from '../../core/workflow/context';
import { resumeExecution, isSpecRunning, computeNextAt } from '../../core/workflow/scheduler';
import { parseCron } from '../../core/workflow/cron';
import { WorkflowSpec } from '../../core/workflow/types';
import { runLogFile, tailRunLog } from '../../utils/fileLogger';
import { yunxiaoConfigured } from '../../core/state/yunxiaoConfig';
import { getCoderConfig, CoderTool, isCoderTool } from '../../core/state/coderConfig';
import { getWorkItem } from '../../core/yunxiao/api';
import { genWorkflowId } from '../../core/workflow/planner';
import { buildFixBugSpec } from '../../core/workflow/fixBug';
import * as git from '../../core/git';

/**
 * 工作流管理路由：
 * - GET  /api/workflows                    列表（spec 摘要 + checkpoint 状态）
 * - GET  /api/workflows/:id                详情 { spec, state }
 * - POST /api/workflows/:id/run            从头执行（异步，202 立即返回）
 * - POST /api/workflows/:id/resume         断点续跑（异步，202 立即返回）
 * - GET  /api/workflows/:id/events         SSE：执行进度（state）+ 危险步骤确认（confirm）
 * - POST /api/workflows/:id/confirm        应答危险步骤确认 { confirmId, ok }
 * - GET  /api/workflows/:id/logs           运行日志（?tail=N，默认 200 行）
 * - GET  /api/workflows/:id/logs/stream    SSE 增量推送运行日志
 *
 * run/resume 的 confirm 与 agent 共用 EventHub 确认桥（频道 workflow:<id>）。
 * engine 的进度通过轮询 checkpoint（~/.sejuani/workflows/<id>.state.json）转推 SSE，
 * 不侵入 core；同时只允许一个工作流在跑（fileLogger 的运行日志是全局单例）。
 */

/** 当前正在执行的工作流 id（同一时刻只允许一个） */
let runningId: string | null = null;

function channelOf(id: string): string {
  return `workflow:${id}`;
}

/** checkpoint 摘要（列表页展示用） */
function summarizeState(id: string): Record<string, unknown> | null {
  const state = loadRunState(id);
  if (!state) return null;
  const count = (s: string) => state.results.filter((r) => r.status === s).length;
  return {
    total: state.results.length,
    ok: count('ok'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending'),
  };
}

/** 启动一次异步执行：进度轮询 checkpoint 转推 SSE，confirm 走确认桥 */
function startRun(config: SejuaniConfig, hub: EventHub, spec: WorkflowSpec, resume: boolean): void {
  const channel = channelOf(spec.id);
  runningId = spec.id;
  hub.publish(channel, 'run-start', { id: spec.id, resume });

  // 轮询 checkpoint，状态变化时推送全量 state（文件很小，全量最简单可靠）
  let lastJson = '';
  const timer = setInterval(() => {
    const state = loadRunState(spec.id);
    if (!state) return;
    const json = JSON.stringify(state);
    if (json !== lastJson) {
      lastJson = json;
      hub.publish(channel, 'state', state);
    }
  }, 500);

  const finish = (data: Record<string, unknown>) => {
    clearInterval(timer);
    runningId = null;
    hub.publish(channel, 'run-end', data);
  };

  buildStepContext(config, spec)
    .then((ctx) =>
      // confirm 注入后，engine 用 SSE 确认桥替代 inquirer 交互（见 engine.ts RunOptions.confirm）
      runWorkflow(spec, ctx, {
        dryRun: false,
        yes: false,
        resume,
        confirm: (message) => hub.ask(channel, message),
      })
    )
    .then((allOk) => finish({ allOk, state: loadRunState(spec.id) }))
    .catch((err) => finish({ allOk: false, error: (err as Error).message }));
}

export function registerWorkflowRoutes(router: Router, hub: EventHub, config: SejuaniConfig): void {
  // 激活触发器列表（W1）——字面路径先于 /api/workflows/:id 注册，避免被路径参数吞掉
  router.get('/api/workflows/triggers', (r) => {
    const items = listSpecs()
      .filter((s) => s.enabled && s.trigger && s.trigger.type !== 'manual')
      .map((s) => ({ id: s.id, title: s.title, trigger: s.trigger, nextAt: computeNextAt(s.trigger!) }));
    sendJson(r.res, 200, items);
  });

  // 待批准队列（W4）
  router.get('/api/workflows/approvals', (r) => {
    const items = listExecutionsByStatus('waiting-approval').map((e) => ({
      execId: e.execId,
      specId: e.specId,
      pendingStep: e.pendingStep,
      trigger: e.trigger,
      startedAt: e.startedAt,
    }));
    sendJson(r.res, 200, items);
  });

  // 批准/拒绝挂起的执行（W4）：批准后危险确认走 SSE 确认桥（频道 workflow:<specId>）
  router.post('/api/workflows/executions/:execId/approve', (r) => {
    const exec = findExecution(r.params.execId);
    if (!exec || exec.status !== 'waiting-approval') {
      sendError(r.res, 404, `未找到待批准执行: ${r.params.execId}`);
      return;
    }
    if (runningId || isSpecRunning(exec.specId)) {
      sendError(r.res, 409, '有工作流正在执行中，请稍后批准。');
      return;
    }
    const channel = channelOf(exec.specId);
    hub.publish(channel, 'run-start', { id: exec.specId, resume: true, approved: exec.execId });
    void resumeExecution(config, exec, {
      unattended: false,
      confirm: (message) => hub.ask(channel, message),
      onEvent: (e) => hub.publish(channel, 'engine-event', e),
    })
      .then((allOk) => hub.publish(channel, 'run-end', { allOk, state: loadRunState(exec.specId) }))
      .catch(() => hub.publish(channel, 'run-end', { allOk: false, error: 'resume 异常' }));
    sendJson(r.res, 202, { ok: true, execId: exec.execId, resumed: true });
  });

  router.post('/api/workflows/executions/:execId/reject', (r) => {
    const exec = findExecution(r.params.execId);
    if (!exec || exec.status !== 'waiting-approval') {
      sendError(r.res, 404, `未找到待批准执行: ${r.params.execId}`);
      return;
    }
    exec.status = 'failed';
    exec.endedAt = new Date().toISOString();
    saveExecution(exec);
    sendJson(r.res, 200, { ok: true, execId: exec.execId, rejected: true });
  });

  // 工作流列表
  router.get('/api/workflows', (r) => {
    const items = listSpecs().map((s) => ({
      id: s.id,
      title: s.title,
      domain: s.domain,
      createdAt: s.createdAt,
      steps: s.steps.length,
      dangerousSteps: s.steps.filter((st) => st.dangerous).length,
      running: runningId === s.id,
      state: summarizeState(s.id),
    }));
    sendJson(r.res, 200, items);
  });

  // 工作流详情
  router.get('/api/workflows/:id', (r) => {
    const spec = loadSpec(r.params.id);
    if (!spec) {
      sendError(r.res, 404, `未找到工作流: ${r.params.id}`);
      return;
    }
    sendJson(r.res, 200, { spec, state: loadRunState(spec.id), running: runningId === spec.id });
  });

  // 从头执行 / 断点续跑（异步）
  const handleRun = (resume: boolean): Parameters<Router['post']>[1] => (r) => {
    const spec = loadSpec(r.params.id);
    if (!spec) {
      sendError(r.res, 404, `未找到工作流: ${r.params.id}`);
      return;
    }
    if (runningId) {
      sendError(r.res, 409, `工作流 ${runningId} 正在执行中，请等待完成后再启动。`);
      return;
    }
    startRun(config, hub, spec, resume);
    sendJson(r.res, 202, { ok: true, started: true, id: spec.id, resume });
  };
  router.post('/api/workflows/:id/run', handleRun(false));
  router.post('/api/workflows/:id/resume', handleRun(true));

  // 激活/停用触发器（W1）
  router.post('/api/workflows/:id/enable', (r) => {
    const spec = loadSpec(r.params.id);
    if (!spec) {
      sendError(r.res, 404, `未找到工作流: ${r.params.id}`);
      return;
    }
    if (!spec.trigger || spec.trigger.type === 'manual') {
      sendError(r.res, 400, '工作流未声明触发器（spec.trigger），无法激活');
      return;
    }
    if (spec.trigger.type === 'cron') {
      try {
        parseCron(spec.trigger.expr);
      } catch (err) {
        sendError(r.res, 400, `cron 表达式非法: ${(err as Error).message}`);
        return;
      }
    }
    spec.enabled = true;
    saveSpec(spec);
    sendJson(r.res, 200, { ok: true, id: spec.id, enabled: true, trigger: spec.trigger });
  });

  router.post('/api/workflows/:id/disable', (r) => {
    const spec = loadSpec(r.params.id);
    if (!spec) {
      sendError(r.res, 404, `未找到工作流: ${r.params.id}`);
      return;
    }
    spec.enabled = false;
    saveSpec(spec);
    sendJson(r.res, 200, { ok: true, id: spec.id, enabled: false });
  });

  // 执行历史（W2）
  router.get('/api/workflows/:id/executions', (r) => {
    const items = listExecutions(r.params.id).map((e) => ({
      execId: e.execId,
      status: e.status,
      trigger: e.trigger,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      okSteps: e.state.results?.filter((s) => s.status === 'ok').length ?? 0,
      totalSteps: e.state.results?.length ?? 0,
    }));
    sendJson(r.res, 200, items);
  });

  router.get('/api/workflows/:id/executions/:execId', (r) => {
    const rec = loadExecution(r.params.id, r.params.execId);
    if (!rec) {
      sendError(r.res, 404, `未找到执行: ${r.params.execId}`);
      return;
    }
    sendJson(r.res, 200, rec);
  });

  // SSE：执行进度 + 危险步骤确认
  router.get('/api/workflows/:id/events', (r) => {
    hub.subscribe(channelOf(r.params.id), r.res);
  });

  // 应答危险步骤确认
  router.post('/api/workflows/:id/confirm', (r) => {
    const { confirmId, ok } = r.body ?? {};
    if (!confirmId) {
      sendError(r.res, 400, '缺少 confirmId');
      return;
    }
    if (!hub.answer(String(confirmId), !!ok)) {
      sendError(r.res, 404, `确认请求不存在或已超时: ${confirmId}`);
      return;
    }
    sendJson(r.res, 200, { ok: true });
  });

  // 运行日志（tail 语义）
  router.get('/api/workflows/:id/logs', (r) => {
    const tail = parseInt(r.query.get('tail') ?? '', 10);
    sendJson(r.res, 200, {
      id: r.params.id,
      file: runLogFile(r.params.id),
      lines: tailRunLog(r.params.id, Number.isNaN(tail) || tail <= 0 ? 200 : tail),
    });
  });

  // SSE 增量推送运行日志（轮询文件追加）
  router.get('/api/workflows/:id/logs/stream', (r) => {
    const file = runLogFile(r.params.id);
    sseOpen(r.res);
    let sent = 0;
    const push = (): void => {
      try {
        if (!fs.existsSync(file)) return;
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
        if (lines.length < sent) sent = 0; // 日志文件被重建时从头推送
        for (; sent < lines.length; sent++) {
          sseSend(r.res, 'log', { line: lines[sent] });
        }
      } catch {
        /* 读取失败等下一轮 */
      }
    };
    push();
    const timer = setInterval(push, 500);
    r.res.on('close', () => clearInterval(timer));
  });

  // POST /api/fix — 便捷 AI 修复入口（创建 fix 工作流并启动）
  router.post('/api/fix', async (r) => {
    const { issueId, repoDir, coder, targetBranch, dryRun } = r.body ?? {};
    if (!issueId) {
      sendError(r.res, 400, '缺少 issueId');
      return;
    }
    if (!yunxiaoConfigured()) {
      sendError(r.res, 400, '尚未配置云效 PAT/组织 id');
      return;
    }
    if (runningId) {
      sendError(r.res, 409, `工作流 ${runningId} 正在执行中，请等待完成后再启动。`);
      return;
    }
    const issue = await getWorkItem(String(issueId));
    const coderTool: CoderTool = coder && isCoderTool(String(coder)) ? (String(coder) as CoderTool) : getCoderConfig().activeTool;
    const dir = typeof repoDir === 'string' && repoDir.trim() ? repoDir.trim() : process.cwd();
    const branch = typeof targetBranch === 'string' && targetBranch.trim() ? targetBranch.trim() : (git.currentBranch(dir) ?? 'master');

    const runId = genWorkflowId('fix');
    const spec = buildFixBugSpec(issue, { targetBranch: branch, id: runId, domain: 'fix' });
    saveSpec(spec);

    if (dryRun) {
      sendJson(r.res, 200, { workflowId: runId, started: false, dryRun: true });
      return;
    }

    // 启动异步执行（异常由 Router.dispatch 统一转 500）
    startRun(config, hub, spec, false);
    sendJson(r.res, 202, { workflowId: runId, started: true });
  });
}
