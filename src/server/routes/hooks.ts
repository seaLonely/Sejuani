import { SejuaniConfig } from '../../core/config';
import { Router, sendJson, sendError } from '../http';
import { logEvent } from '../../utils/fileLogger';
import { listSpecs, listExecutionsByStatus } from '../../core/workflow/store';
import { fireWorkflow, resumeExecution, isSpecRunning, hasPendingExecution } from '../../core/workflow/scheduler';

/**
 * Webhook 入口（W1/W3）：POST /api/hooks/:path
 * 1) 触发声明 trigger.type=webhook 且 path 匹配的 enabled 工作流（body 注入 trigger.payload）；
 * 2) 唤醒 wakeWebhook 匹配的 waiting 执行（flow.wait untilWebhook）。
 */
export function registerHookRoutes(router: Router, config: SejuaniConfig): void {
  router.post('/api/hooks/:path', async (r) => {
    const hookPath = r.params.path;
    if (!/^[a-zA-Z0-9._-]+$/.test(hookPath)) {
      sendError(r.res, 400, 'webhook path 非法（仅允许字母/数字/._-）');
      return;
    }
    // 请求体已由 Router 统一解析（非 JSON 会被 400 拦截，空体为 {}）
    const body: any = r.body && typeof r.body === 'object' ? r.body : {};

    // 飞书/企业微信事件订阅的 URL 验证：回显 challenge（U4 入站首次校验必需）
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      logEvent('info', 'hook.urlVerify', { path: hookPath });
      sendJson(r.res, 200, { challenge: body.challenge });
      return;
    }

    const payload: unknown = Object.keys(body).length > 0 ? body : undefined;

    const fired: string[] = [];
    const woken: string[] = [];

    // 1) webhook 触发的工作流（同流在跑/存在挂起执行时跳过，避免覆盖断点）
    for (const spec of listSpecs()) {
      if (!spec.enabled || spec.trigger?.type !== 'webhook' || spec.trigger.path !== hookPath) continue;
      if (isSpecRunning(spec.id) || hasPendingExecution(spec.id)) {
        logEvent('warn', 'hook.skipRunning', { specId: spec.id, path: hookPath });
        continue;
      }
      fired.push(spec.id);
      void fireWorkflow(config, spec, { type: 'webhook', payload });
    }

    // 2) 唤醒等待该 webhook 的 waiting 执行
    for (const exec of listExecutionsByStatus('waiting')) {
      if (exec.wakeWebhook !== hookPath || isSpecRunning(exec.specId)) continue;
      woken.push(exec.execId);
      void resumeExecution(config, exec);
    }

    logEvent('info', 'hook.received', { path: hookPath, fired, woken });
    sendJson(r.res, 200, { ok: true, fired, woken });
  });
}
