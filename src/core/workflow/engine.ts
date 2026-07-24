import inquirer from 'inquirer';
import { chalk, logger } from '../../utils/logger';
import { logEvent, startRunLog, endRunLog, isRunLogActive, currentRunLogFile } from '../../utils/fileLogger';
import { STEP_HANDLERS, confirmDangerous } from './steps';
import { saveRunState, saveSpec, loadRunState } from './store';
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
      return { specId: spec.id, results };
    }
  }
  return { specId: spec.id, results: spec.steps.map((s) => ({ id: s.id, status: 'pending' as const })) };
}

/**
 * 补全步骤缺失的必填参数。交互模式提示输入并写回 params；
 * --yes 非交互时无法补全，返回仍缺失的字段名。
 */
async function fillNeedsInput(step: WorkflowStep, yes: boolean): Promise<string[]> {
  const isEmpty = (f: string): boolean => {
    const v = step.params[f];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  };
  const need = (step.needsInput ?? []).filter(isEmpty);
  if (need.length === 0) {
    step.needsInput = undefined;
    return [];
  }
  if (yes) return need; // 非交互模式无法补全
  for (const field of need) {
    const { val } = await inquirer.prompt<{ val: string }>([
      {
        type: 'input',
        name: 'val',
        message: `步骤「${step.title}」需补全参数 ${chalk.cyan(field)}（如分支名）:`,
        filter: (v: string) => v.trim(),
      },
    ]);
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
  const resultById = new Map(state.results.map((r) => [r.id, r]));

  // 整体确认全部危险步骤
  const dangerous = ordered.filter((s) => s.dangerous && resultById.get(s.id)?.status !== 'ok');
  if (dangerous.length > 0 && !opts.yes) {
    logger.warn(`\n本次将执行 ${dangerous.length} 个不可逆步骤：`);
    for (const s of dangerous) logger.info('  ' + chalk.yellow(`⚠ ${s.title} (${s.kind})`));
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      { type: 'confirm', name: 'proceed', message: '已知晓上述不可逆操作，继续?', default: false },
    ]);
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

    // 补全缺失的必填参数（如 git.merge 的 from）
    if (step.needsInput && step.needsInput.length > 0) {
      const stillEmpty = await fillNeedsInput(step, opts.yes);
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
      const ok = await confirmDangerous(step);
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
    result.status = 'pending';
    result.startedAt = now();
    saveRunState(state);
    logEvent('info', 'step.start', { id: step.id, kind: step.kind, title: step.title, params: step.params });
    try {
      const res = await STEP_HANDLERS[step.kind].execute(step, ctx);
      result.status = res.ok ? 'ok' : 'failed';
      result.reason = res.reason;
    } catch (err) {
      result.status = 'failed';
      result.reason = (err as Error).message;
    }
    result.endedAt = now();
    saveRunState(state);
    logEvent(result.status === 'ok' ? 'info' : 'error', 'step.end', {
      id: step.id,
      status: result.status,
      reason: result.reason,
    });

    if (result.status !== 'ok') {
      allOk = false;
      logger.error(`步骤失败：${step.title}（${result.reason ?? '未知原因'}）`);
      logger.warn(`已在此处停止。修复后可执行： sjn flow resume ${spec.id}`);
      break;
    }
    logger.success(`完成：${step.title}${result.reason ? chalk.dim('  ' + result.reason) : ''}`);
  }

  // 汇总
  logger.title('工作流执行结果');
  const okCount = state.results.filter((r) => r.status === 'ok').length;
  logger.success(`成功 ${okCount}/${state.results.length} 步`);
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
  logger.info(chalk.dim(`完整运行日志: ${runLogPath}`));
  return allOk;
}
