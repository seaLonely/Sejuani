import { chalk, logger } from '../../utils/logger';
import { logEvent } from '../../utils/fileLogger';
import { SejuaniConfig } from '../config';
import { buildStepContext } from './context';
import { runWorkflow, WorkflowEvent } from './engine';
import { parseCron, cronMatches, nextCronTime, CronSchedule } from './cron';
import {
  activeSpecs,
  loadSpec,
  ExecutionRecord,
  genExecId,
  saveExecution,
  listExecutionsByStatus,
  loadWatermark,
  saveWatermark,
  TriggerWatermark,
} from './store';
import { TriggerSpec, WorkflowSpec } from './types';
import { listWorkItems } from '../yunxiao/api';
import { yunxiaoConfigured } from '../state/yunxiaoConfig';
import { WorkItem } from '../yunxiao/types';
import { ConfirmFn, PromptInputFn } from '../types';

/**
 * 常驻调度器（W1）：注册 enabled 工作流的触发器，分钟级 tick 驱动。
 * - interval / cron：到点触发执行；
 * - yunxiao.item：按 pollMinutes 轮询工单，水位去重后逐条触发；
 * - waiting 执行的 wakeAt 到期自动唤醒 resume（W3 flow.wait）；
 * - 并发闸：同 spec 单飞 + 全局上限；重叠按 overlapPolicy（默认 skip）。
 * 调度触发的执行一律 unattended：危险步骤挂起 waiting-approval，绝不静默执行。
 */

export interface SchedulerOptions {
  /** 全局并发上限，默认 1（沿用「同时只跑一个工作流」约束） */
  maxConcurrent?: number;
  /** 同一 spec 触发重叠时的策略，默认 'skip' */
  overlapPolicy?: 'skip' | 'queue';
  /** 执行事件外发（供 serve 转 SSE） */
  onEvent?: (specId: string, e: WorkflowEvent) => void;
  /**
   * 保活模式：定时器不 unref（flow watch 等无其它活跃句柄的纯调度进程必须开启，
   * 否则事件循环清空后进程直接退出）；serve 场景由 HTTP 句柄维持，缺省 false。
   */
  keepAlive?: boolean;
}

export interface ActiveTrigger {
  specId: string;
  title: string;
  trigger: TriggerSpec;
  /** 下次触发时间（cron/interval 可算；事件型为 null） */
  nextAt: string | null;
}

export interface SchedulerHandle {
  stop(): void;
  reload(): void;
  listActive(): ActiveTrigger[];
}

/** 触发来源描述 */
export interface FireTrigger {
  type: string;
  item?: unknown;
  payload?: unknown;
}

// ── 并发闸（模块级：serve 内 HTTP 手动 run 与调度共存时也只跑一个） ──
const runningSpecs = new Set<string>();
let runningCount = 0;

/** 当前是否有工作流在跑（供路由层判断） */
export function isSpecRunning(specId: string): boolean {
  return runningSpecs.has(specId);
}

/**
 * 是否存在挂起中（waiting / waiting-approval）的执行：
 * 此时禁止同 spec 新触发，避免新执行覆盖 <id>.state.json 断点导致
 * 挂起执行唤醒后漏执行/重复执行危险步骤。
 */
export function hasPendingExecution(specId: string): boolean {
  return (
    listExecutionsByStatus('waiting').some((e) => e.specId === specId) ||
    listExecutionsByStatus('waiting-approval').some((e) => e.specId === specId)
  );
}

/**
 * 触发一次工作流执行（调度器/webhook/手动共用）：
 * 创建执行存档 → 构建上下文（注入 trigger）→ runWorkflow。
 * unattended 缺省 true（无人值守语义）。
 */
export async function fireWorkflow(
  config: SejuaniConfig,
  spec: WorkflowSpec,
  trigger: FireTrigger,
  opts: { unattended?: boolean; confirm?: ConfirmFn; promptInput?: PromptInputFn; onEvent?: (e: WorkflowEvent) => void } = {}
): Promise<ExecutionRecord> {
  const firedAt = new Date().toISOString();
  const exec: ExecutionRecord = {
    execId: genExecId(spec.id),
    specId: spec.id,
    trigger: { type: trigger.type, firedAt, item: trigger.item, payload: trigger.payload },
    status: 'running',
    state: { specId: spec.id, results: [] },
    startedAt: firedAt,
  };
  saveExecution(exec);
  runningSpecs.add(spec.id);
  runningCount++;
  try {
    const ctx = await buildStepContext(config, spec);
    ctx.trigger = exec.trigger;
    await runWorkflow(spec, ctx, {
      dryRun: false,
      yes: false,
      resume: false,
      unattended: opts.unattended ?? true,
      confirm: opts.confirm,
      promptInput: opts.promptInput,
      onEvent: opts.onEvent,
      execution: exec,
    });
  } catch (err) {
    exec.status = 'failed';
    exec.endedAt = new Date().toISOString();
    saveExecution(exec);
    logEvent('error', 'trigger.runError', { specId: spec.id, error: (err as Error).message });
  } finally {
    runningSpecs.delete(spec.id);
    runningCount--;
  }
  return exec;
}

/**
 * 恢复一个挂起/中断的执行（waiting 唤醒、waiting-approval 批准共用）：
 * resume 模式续跑，交互回调由调用方注入（批准场景传 confirm；唤醒场景 unattended）。
 */
export async function resumeExecution(
  config: SejuaniConfig,
  exec: ExecutionRecord,
  opts: { unattended?: boolean; confirm?: ConfirmFn; promptInput?: PromptInputFn; onEvent?: (e: WorkflowEvent) => void } = {}
): Promise<boolean> {
  const spec = loadSpec(exec.specId);
  if (!spec) {
    exec.status = 'failed';
    exec.endedAt = new Date().toISOString();
    saveExecution(exec);
    return false;
  }
  runningSpecs.add(spec.id);
  runningCount++;
  try {
    const ctx = await buildStepContext(config, spec);
    ctx.trigger = exec.trigger;
    return await runWorkflow(spec, ctx, {
      dryRun: false,
      yes: false,
      resume: true,
      unattended: opts.unattended ?? true,
      confirm: opts.confirm,
      promptInput: opts.promptInput,
      onEvent: opts.onEvent,
      execution: exec,
    });
  } catch (err) {
    // 与 fireWorkflow 对齐：resume 异常（建上下文/环依赖等）标记 failed，
    // 绝不向上抛——调用方多为 void 调用，unhandled rejection 会打崩常驻 serve。
    exec.status = 'failed';
    exec.endedAt = new Date().toISOString();
    saveExecution(exec);
    logEvent('error', 'resume.runError', { execId: exec.execId, error: (err as Error).message });
    return false;
  } finally {
    runningSpecs.delete(spec.id);
    runningCount--;
  }
}

/** 计算触发器下次触发时间（展示用） */
export function computeNextAt(trigger: TriggerSpec, lastFired?: number): string | null {
  const nowMs = Date.now();
  if (trigger.type === 'interval') {
    const base = lastFired ?? nowMs;
    return new Date(base + trigger.everyMinutes * 60000).toISOString();
  }
  if (trigger.type === 'cron') {
    try {
      const next = nextCronTime(parseCron(trigger.expr), new Date());
      return next ? next.toISOString() : null;
    } catch {
      return null;
    }
  }
  if (trigger.type === 'yunxiao.item') {
    const base = lastFired ?? nowMs;
    return new Date(base + trigger.pollMinutes * 60000).toISOString();
  }
  return null; // webhook / manual
}

/** 拉取云效工单并按水位去重，返回新命中的工单与水位（不写盘，由调用方在派发接受后写入，避免 skip 的工单永久丢失） */
async function pollYunxiaoItems(
  specId: string,
  trigger: Extract<TriggerSpec, { type: 'yunxiao.item' }>
): Promise<{ fresh: WorkItem[]; wm: TriggerWatermark; firstRun: boolean }> {
  const wm = loadWatermark(specId);
  const firstRun = !wm.lastPolledAt;
  if (!yunxiaoConfigured()) return { fresh: [], wm, firstRun };
  const items = await listWorkItems({
    type: trigger.filter?.itemType,
    statusName: trigger.filter?.statusName,
    limit: 50,
    applyDefaults: !!trigger.filter?.assignedToMe,
  });
  const seen = new Set(wm.seenIds);
  const fresh = items.filter((it) => !seen.has(it.id));
  if (firstRun) {
    // 首次轮询只建基线不触发：避免存量工单一次性涌入
    saveWatermark(specId, {
      seenIds: [...wm.seenIds, ...fresh.map((it) => it.id)],
      lastPolledAt: new Date().toISOString(),
    });
    return { fresh: [], wm, firstRun };
  }
  return { fresh, wm, firstRun };
}

/** 启动常驻调度器；返回句柄（stop/reload/listActive） */
export function startScheduler(config: SejuaniConfig, opts: SchedulerOptions = {}): SchedulerHandle {
  const maxConcurrent = opts.maxConcurrent ?? 1;
  const overlapPolicy = opts.overlapPolicy ?? 'skip';

  let specs: WorkflowSpec[] = [];
  /** 每 spec 的调度态：cron 解析缓存 / 上次触发时间 / 上次命中的分钟 */
  const runtime = new Map<string, { cron?: CronSchedule; lastFired?: number; lastCronMinute?: string }>();
  /** queue 策略下的待执行队列 */
  const pending: Array<{ spec: WorkflowSpec; trigger: FireTrigger }> = [];

  const reload = (): void => {
    specs = activeSpecs();
    for (const s of specs) {
      if (!runtime.has(s.id)) runtime.set(s.id, {});
      const rt = runtime.get(s.id)!;
      if (s.trigger?.type === 'cron') {
        try {
          rt.cron = parseCron(s.trigger.expr);
        } catch (err) {
          rt.cron = undefined;
          logEvent('warn', 'trigger.badCron', { specId: s.id, error: (err as Error).message });
        }
      }
    }
    logEvent('info', 'scheduler.reload', { active: specs.length });
  };

  /** 派发一次触发；返回是否被接受（fire 或入队），供事件型触发按接受结果写水位 */
  const dispatch = (spec: WorkflowSpec, trigger: FireTrigger): boolean => {
    // 存在挂起执行时禁止新触发：避免新执行覆盖 state.json 断点（见 hasPendingExecution）
    if (hasPendingExecution(spec.id)) {
      logEvent('warn', 'trigger.suppressed', { specId: spec.id, type: trigger.type, reason: '存在挂起执行(waiting/waiting-approval)' });
      return false;
    }
    if (runningSpecs.has(spec.id) || runningCount >= maxConcurrent) {
      if (overlapPolicy === 'queue') {
        pending.push({ spec, trigger });
        logEvent('info', 'trigger.queued', { specId: spec.id, type: trigger.type });
        return true;
      }
      logEvent('warn', 'trigger.skipped', { specId: spec.id, type: trigger.type, reason: '并发上限/同流在跑' });
      return false;
    }
    const rt = runtime.get(spec.id);
    if (rt) rt.lastFired = Date.now();
    logger.step(`触发工作流 ${chalk.cyan(spec.id)}（${trigger.type}）`);
    logEvent('info', 'trigger.fired', { specId: spec.id, type: trigger.type });
    void fireWorkflow(config, spec, trigger, { onEvent: (e) => opts.onEvent?.(spec.id, e) }).finally(() => {
      // 执行结束后 drain 队列
      const next = pending.shift();
      if (next) dispatch(next.spec, next.trigger);
    });
    return true;
  };

  const tick = (): void => {
    const nowDate = new Date();
    const minuteKey = nowDate.toISOString().slice(0, 16);
    for (const spec of specs) {
      const trigger = spec.trigger!;
      const rt = runtime.get(spec.id) ?? {};
      if (trigger.type === 'interval') {
        const due = (rt.lastFired ?? 0) + trigger.everyMinutes * 60000 <= Date.now();
        if (due) dispatch(spec, { type: 'interval' });
      } else if (trigger.type === 'cron') {
        if (rt.cron && rt.lastCronMinute !== minuteKey && cronMatches(rt.cron, nowDate)) {
          rt.lastCronMinute = minuteKey;
          dispatch(spec, { type: 'cron' });
        }
      } else if (trigger.type === 'yunxiao.item') {
        const due = (rt.lastFired ?? 0) + trigger.pollMinutes * 60000 <= Date.now();
        if (due) {
          rt.lastFired = Date.now(); // 轮询节流（无论是否命中）
          void pollYunxiaoItems(spec.id, trigger)
            .then(({ fresh, wm, firstRun }) => {
              if (firstRun || fresh.length === 0) return;
              // 仅把「被接受」的工单写入水位；被 skip 的下轮重新命中，避免同批多单永久丢失
              const accepted: string[] = [];
              for (const item of fresh) {
                if (dispatch(spec, { type: 'yunxiao.item', item })) accepted.push(item.id);
              }
              if (accepted.length > 0) {
                saveWatermark(spec.id, {
                  seenIds: [...wm.seenIds, ...accepted],
                  lastPolledAt: new Date().toISOString(),
                } as TriggerWatermark);
              }
            })
            .catch((err) => logEvent('warn', 'trigger.pollError', { specId: spec.id, error: (err as Error).message }));
        }
      }
    }
    // W3：唤醒到期的 waiting 执行
    for (const exec of listExecutionsByStatus('waiting')) {
      if (exec.wakeAt && Date.parse(exec.wakeAt) <= Date.now() && !runningSpecs.has(exec.specId) && runningCount < maxConcurrent) {
        logger.step(`唤醒等待中的执行 ${chalk.cyan(exec.execId)}`);
        logEvent('info', 'waiting.wake', { execId: exec.execId });
        void resumeExecution(config, exec, { onEvent: (e) => opts.onEvent?.(exec.specId, e) });
      }
    }
  };

  // 崩溃恢复：上次进程遗留的 running 执行标记 interrupted
  for (const exec of listExecutionsByStatus('running')) {
    exec.status = 'interrupted';
    exec.endedAt = new Date().toISOString();
    saveExecution(exec);
    logEvent('warn', 'execution.interrupted', { execId: exec.execId });
  }

  reload();
  const tickTimer = setInterval(tick, 60 * 1000);
  const reloadTimer = setInterval(reload, 30 * 1000);
  // serve 由 HTTP 句柄保活，定时器 unref 避免阻碍退出；
  // flow watch 等纯调度进程必须 keepAlive，否则事件循环清空后进程立即退出
  if (!opts.keepAlive) {
    tickTimer.unref();
    reloadTimer.unref();
  }
  logger.info(chalk.dim(`调度器已启动：${specs.length} 个激活触发器（每分钟 tick）`));

  return {
    stop() {
      clearInterval(tickTimer);
      clearInterval(reloadTimer);
    },
    reload,
    listActive(): ActiveTrigger[] {
      return specs.map((s) => ({
        specId: s.id,
        title: s.title,
        trigger: s.trigger!,
        nextAt: computeNextAt(s.trigger!, runtime.get(s.id)?.lastFired),
      }));
    },
  };
}
