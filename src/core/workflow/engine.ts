import { chalk, logger } from '../../utils/logger';
import { logEvent, startRunLog, endRunLog, isRunLogActive, currentRunLogFile } from '../../utils/fileLogger';
import { ConfirmFn, PromptInputFn } from '../types';
import { STEP_HANDLERS, confirmDangerous, evaluateSkipIf } from './steps';
import { saveRunState, saveSpec, loadRunState } from './store';
import { hydrateContext } from './context';
import { RunState, StepContext, StepResult, WorkflowSpec, WorkflowStep } from './types';

/**
 * 执行引擎：拓扑排序 → dry-run 预览 / 正式执行。
 * - dry-run：仅逐步调用 preview() 打印，不落盘不执行。
 * - 正式执行：先整体确认全部危险步骤；逐步执行，危险步骤在未给 --yes 时二次确认；
 *   每步结果写入 checkpoint；失败即停；--resume 跳过已 ok 步骤从失败处继续。
 */

export interface RunOptions {
  dryRun: boolean;
  yes: boolean;
  resume: boolean;
  /**
   * 确认回调：CLI/向导传 inquirer 实现，sjn serve 传 SSE 确认桥。
   * yes=false 且未提供时，危险步骤一律视为拒绝（不会默默执行）。
   */
  confirm?: ConfirmFn;
  /** 输入回调：补全步骤缺失的必填参数；未提供时与 --yes 一样无法补全。 */
  promptInput?: PromptInputFn;
  /**
   * 执行进度事件回调：供 Agent 会话/服务端在 stdout 之外感知进度。
   * 回调异常会被吞掉，不影响工作流执行。
   */
  onEvent?: (e: WorkflowEvent) => void;
}

/** 执行进度事件（onEvent 外发） */
export interface WorkflowEvent {
  type: 'step-start' | 'step-end' | 'workflow-end';
  stepId?: string;
  title?: string;
  /** step-end 时携带该步终态；workflow-end 时为整体结果（ok/failed） */
  status?: string;
  reason?: string;
  /** 第几步 / 总步数 */
  index?: number;
  total?: number;
}

/** 依 dependsOn 做拓扑排序；存在环则抛错。 */
export function topoSort(steps: WorkflowStep[]): WorkflowStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const s of steps) {
    indeg.set(s.id, 0);
    adj.set(s.id, []);
  }
  for (const s of steps) {
    for (const dep of s.dependsOn ?? []) {
      if (!byId.has(dep)) continue;
      adj.get(dep)!.push(s.id);
      indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
    }
  }
  // 保持原始顺序作为同层稳定排序
  const order = steps.map((s) => s.id);
  const queue = order.filter((id) => (indeg.get(id) ?? 0) === 0);
  const sorted: WorkflowStep[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(byId.get(id)!);
    for (const next of adj.get(id) ?? []) {
      indeg.set(next, (indeg.get(next) ?? 0) - 1);
      if ((indeg.get(next) ?? 0) === 0) queue.push(next);
    }
  }
  if (sorted.length !== steps.length) {
    throw new Error('工作流步骤存在循环依赖(dependsOn)，无法排序执行。');
  }
  return sorted;
}

/** 渲染工作流供审阅：步骤顺序、危险标记、依赖、每步 preview。 */
export function renderWorkflow(spec: WorkflowSpec, ctx: StepContext): void {
  const ordered = topoSort(spec.steps);
  logger.title(`工作流审阅：${spec.title}`);
  logger.info(chalk.dim(`id: ${spec.id}   域: ${spec.domain}   共 ${ordered.length} 步`));
  ordered.forEach((step, i) => {
    const danger = step.dangerous ? chalk.yellow(' [不可逆]') : '';
    const deps = step.dependsOn && step.dependsOn.length ? chalk.dim(`  ← ${step.dependsOn.join(', ')}`) : '';
    logger.info(`\n${chalk.bold(`${i + 1}. ${step.title}`)} ${chalk.dim(`(${step.kind})`)}${danger}${deps}`);
    if (step.needsInput && step.needsInput.length > 0) {
      logger.warn(`   需补全：${step.needsInput.join(', ')}（执行前会提示输入）`);
    }
    const handler = STEP_HANDLERS[step.kind];
    for (const line of handler.preview(step, ctx)) {
      logger.info('   ' + line);
    }
  });
  const dangerous = ordered.filter((s) => s.dangerous);
  if (dangerous.length > 0) {
    logger.warn(`\n包含 ${dangerous.length} 个不可逆步骤：${dangerous.map((s) => s.title).join('、')}`);
  }
}

function now(): string {
  return new Date().toISOString();
}

/** 初始化/续跑的运行状态：resume 时读旧 state，否则全新 pending。 */
function initRunState(spec: WorkflowSpec, resume: boolean): RunState {
  if (resume) {
    const prev = loadRunState(spec.id);
    if (prev) {
      // 补齐可能新增的步骤
      const known = new Map(prev.results.map((r) => [r.id, r]));
      const results: StepResult[] = spec.steps.map(
        (s) => known.get(s.id) ?? { id: s.id, status: 'pending' }
      );
      return { specId: spec.id, results, startedAt: prev.startedAt };
    }
  }
  return { specId: spec.id, results: spec.steps.map((s) => ({ id: s.id, status: 'pending' as const })) };
}

/** 简单延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 执行单步（含重试）：步骤级 retry 优先，其次 kind 默认 defaultRetry；
 * 失败且未耗尽时等待 delayMs 后重试，每次重试 logEvent step.retry。
 */
async function executeWithRetry(
  step: WorkflowStep,
  ctx: StepContext
): Promise<{ ok: boolean; reason?: string; outputs?: Record<string, unknown> }> {
  const handler = STEP_HANDLERS[step.kind];
  const policy = step.retry ?? handler.describe().defaultRetry;
  const maxRetries = policy?.max ?? 0;
  const delayMs = policy?.delayMs ?? 3000;
  let last: { ok: boolean; reason?: string; outputs?: Record<string, unknown> };
  for (let attempt = 0; ; attempt++) {
    try {
      last = await handler.execute(step, ctx);
    } catch (err) {
      last = { ok: false, reason: (err as Error).message };
    }
    if (last.ok || attempt >= maxRetries) return last;
    logEvent('warn', 'step.retry', { id: step.id, attempt: attempt + 1, max: maxRetries, reason: last.reason });
    logger.warn(`  步骤失败，${Math.round(delayMs / 1000)}s 后重试（${attempt + 1}/${maxRetries}）：${last.reason ?? ''}`);
    await sleep(delayMs);
  }
}

/**
 * 补全步骤缺失的必填参数。交互模式（提供 promptInput）时提示输入并写回 params；
 * --yes 或未提供输入回调时无法补全，返回仍缺失的字段名。
 */
async function fillNeedsInput(step: WorkflowStep, yes: boolean, promptInput?: PromptInputFn): Promise<string[]> {
  const isEmpty = (f: string): boolean => {
    const v = step.params[f];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  };
  const need = (step.needsInput ?? []).filter(isEmpty);
  if (need.length === 0) {
    step.needsInput = undefined;
    return [];
  }
  if (yes || !promptInput) return need; // 非交互模式无法补全
  for (const field of need) {
    const val = await promptInput(`步骤「${step.title}」需补全参数 ${chalk.cyan(field)}（如分支名）:`);
    if (val) step.params[field] = val;
  }
  const stillEmpty = need.filter(isEmpty);
  step.needsInput = stillEmpty.length > 0 ? stillEmpty : undefined;
  return stillEmpty;
}

/**
 * 执行工作流。返回是否全部成功（dry-run 恒为 true）。
 */
export async function runWorkflow(spec: WorkflowSpec, ctx: StepContext, opts: RunOptions): Promise<boolean> {
  const ordered = topoSort(spec.steps);

  if (opts.dryRun) {
    renderWorkflow(spec, ctx);
    logger.info(chalk.yellow('\n[dry-run] 仅预览，未执行任何步骤。'));
    return true;
  }

  // 落盘 spec，便于后续 flow run/resume 复用
  const specPath = saveSpec(spec);
  logger.info(chalk.dim(`已保存工作流定义: ${specPath}`));
  // 若调用方（如 AI 工作流）已在规划前开启了同名运行日志，则复用（AI 原文已写入该日志）；否则（如 flow run/resume）新开启。
  const reused = isRunLogActive(spec.id);
  const runLogPath = reused ? currentRunLogFile()! : startRunLog(spec.id);
  if (!reused) logger.info(chalk.dim(`运行日志: ${runLogPath}`));
  logEvent('info', 'workflow.start', { specId: spec.id, title: spec.title, resume: opts.resume, steps: ordered.length });

  const state = initRunState(spec, opts.resume);
  if (!state.startedAt) state.startedAt = now();
  // resume：把已完成步骤的产物回放到执行上下文（如 mrUrl / foundProjects）
  if (opts.resume) hydrateContext(state, spec, ctx);
  const resultById = new Map(state.results.map((r) => [r.id, r]));
  /** 安全外发进度事件（回调异常不影响执行） */
  const emit = (e: WorkflowEvent): void => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* 事件回调异常忽略 */
    }
  };

  // 整体确认全部危险步骤
  const dangerous = ordered.filter((s) => s.dangerous && resultById.get(s.id)?.status !== 'ok');
  if (dangerous.length > 0 && !opts.yes) {
    logger.warn(`\n本次将执行 ${dangerous.length} 个不可逆步骤：`);
    for (const s of dangerous) logger.info('  ' + chalk.yellow(`⚠ ${s.title} (${s.kind})`));
    const proceed = opts.confirm ? await opts.confirm('已知晓上述不可逆操作，继续?') : false;
    if (!proceed) {
      logger.warn('已取消，未执行任何步骤。');
      return false;
    }
  }

  let allOk = true;
  let done = 0;
  for (const step of ordered) {
    done++;
    const result = resultById.get(step.id)!;
    if (opts.resume && result.status === 'ok') {
      logger.step(`[${done}/${ordered.length}] 跳过已完成：${chalk.dim(step.title)}`);
      continue;
    }

    // 条件跳过（skipIf）：命中则标记 skipped，但不中断后续步骤
    const skipReason = evaluateSkipIf(step, ctx);
    if (skipReason) {
      result.status = 'skipped';
      result.reason = `[条件跳过] ${skipReason}`;
      saveRunState(state);
      logEvent('info', 'step.skipIf', { id: step.id, reason: skipReason });
      logger.step(`[${done}/${ordered.length}] 条件跳过：${chalk.dim(step.title)}（${skipReason}）`);
      emit({ type: 'step-end', stepId: step.id, title: step.title, status: 'skipped', reason: result.reason, index: done, total: ordered.length });
      continue;
    }

    // 补全缺失的必填参数（如 git.merge 的 from）
    if (step.needsInput && step.needsInput.length > 0) {
      const stillEmpty = await fillNeedsInput(step, opts.yes, opts.promptInput);
      if (stillEmpty.length > 0) {
        result.status = 'failed';
        result.reason = `缺少必填参数: ${stillEmpty.join(', ')}`;
        saveRunState(state);
        logEvent('warn', 'step.needsInput', { id: step.id, missing: stillEmpty });
        logger.error(`步骤「${step.title}」缺少参数 ${stillEmpty.join(', ')}（--yes 无法自动补全）。`);
        logger.warn(`已在此停止。补全后可执行： sjn flow resume ${spec.id}`);
        allOk = false;
        break;
      }
      saveSpec(spec); // 补全后回写定义，便于 resume
    }

    // 危险步骤逐步二次确认（未给 --yes 时）
    if (step.dangerous && !opts.yes) {
      const ok = await confirmDangerous(step, opts.confirm);
      if (!ok) {
        result.status = 'skipped';
        result.reason = '用户取消危险步骤';
        saveRunState(state);
        logEvent('warn', 'step.dangerous.cancel', { id: step.id, title: step.title });
        logger.warn(`已取消危险步骤「${step.title}」，中止后续执行。可稍后用 flow resume 继续。`);
        allOk = false;
        break;
      }
    }

    logger.title(`[${done}/${ordered.length}] ${step.title} (${step.kind})`);
    emit({ type: 'step-start', stepId: step.id, title: step.title, index: done, total: ordered.length });
    result.status = 'pending';
    result.startedAt = now();
    saveRunState(state);
    logEvent('info', 'step.start', { id: step.id, kind: step.kind, title: step.title, params: step.params });
    const res = await executeWithRetry(step, ctx);
    result.status = res.ok ? 'ok' : 'failed';
    result.reason = res.reason;
    if (res.outputs) {
      result.outputs = res.outputs;
      ctx.runOutputs = ctx.runOutputs ?? {};
      ctx.runOutputs[step.id] = res.outputs;
    }
    result.endedAt = now();
    saveRunState(state);
    logEvent(result.status === 'ok' ? 'info' : 'error', 'step.end', {
      id: step.id,
      status: result.status,
      reason: result.reason,
    });
    emit({ type: 'step-end', stepId: step.id, title: step.title, status: result.status, reason: result.reason, index: done, total: ordered.length });

    if (result.status !== 'ok') {
      allOk = false;
      logger.error(`步骤失败：${step.title}（${result.reason ?? '未知原因'}）`);
      logger.warn(`已在此处停止。修复后可执行： sjn flow resume ${spec.id}`);
      break;
    }
    logger.success(`完成：${step.title}${result.reason ? chalk.dim('  ' + result.reason) : ''}`);
  }

  // 汇总
  state.endedAt = now();
  saveRunState(state);
  logger.title('工作流执行结果');
  const okCount = state.results.filter((r) => r.status === 'ok').length;
  logger.success(`成功 ${okCount}/${state.results.length} 步`);
  // 每步耗时与总耗时
  const durations = state.results
    .filter((r) => r.startedAt && r.endedAt)
    .map((r) => `${r.id} ${Math.max(0, Math.round((Date.parse(r.endedAt!) - Date.parse(r.startedAt!)) / 1000))}s`);
  if (durations.length > 0) {
    const total = state.startedAt
      ? `  总计 ${Math.max(0, Math.round((Date.parse(state.endedAt) - Date.parse(state.startedAt)) / 1000))}s`
      : '';
    logger.info(chalk.dim(`  耗时: ${durations.join(' · ')}${total}`));
  }
  const notOk = state.results.filter((r) => r.status !== 'ok' && r.status !== 'pending');
  for (const r of notOk) {
    logger.info('  ' + chalk.red(r.id) + chalk.dim(`  ${r.status}  ${r.reason ?? ''}`));
  }
  if (allOk) logger.success('工作流全部完成 🎉');
  logEvent(allOk ? 'info' : 'warn', 'workflow.end', {
    allOk,
    okCount,
    total: state.results.length,
    failed: notOk.map((r) => ({ id: r.id, status: r.status, reason: r.reason })),
  });
  endRunLog({ allOk, okCount, total: state.results.length });
  emit({ type: 'workflow-end', status: allOk ? 'ok' : 'failed', reason: `成功 ${okCount}/${state.results.length} 步`, total: state.results.length });
  logger.info(chalk.dim(`完整运行日志: ${runLogPath}`));
  return allOk;
}
