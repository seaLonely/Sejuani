import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { inquirerConfirm, inquirerInput } from '../../ui/prompt';
import { loadConfig } from '../../core/config';
import { SejuaniConfig } from '../../core/config';
import {
  listSpecs,
  loadSpec,
  saveSpec,
  workflowsDir,
  listExecutions,
  listExecutionsByStatus,
  findExecution,
  saveExecution,
} from '../../core/workflow/store';
import { renderWorkflow, runWorkflow } from '../../core/workflow/engine';
import { buildStepContext } from '../../core/workflow/context';
import { startScheduler, resumeExecution, computeNextAt } from '../../core/workflow/scheduler';
import { parseCron } from '../../core/workflow/cron';
import { listTemplates, loadTemplate, removeTemplate, templatesDir } from '../../core/workflow/templates';
import { skillFromWorkflow } from '../../core/skill/creator';
import { saveSkill } from '../../core/skill/store';
import { runLogFile, tailRunLog, logsDir } from '../../utils/fileLogger';

/**
 * 工作流模板管理：list / show <name> / rm <name>。
 * （sub 取自 flow 命令的第二个位置参，name 取自第三个）
 */
function handleFlowTemplate(sub: string | undefined, name: string | undefined): void {
  const s = (sub ?? 'list').toLowerCase();
  if (s === 'list' || s === 'ls') {
    const tpls = listTemplates();
    logger.title(`工作流模板（${tpls.length}）`);
    if (tpls.length === 0) {
      logger.info(chalk.dim(`  暂无。用 sjn ai ... --save-template <名> 创建。目录: ${templatesDir()}`));
      return;
    }
    for (const t of tpls) {
      logger.info(`  ${chalk.bold(t.name)}  ${t.title}  ${chalk.dim(`${t.steps.length}步 ${t.savedAt}`)}`);
    }
    logger.info(chalk.dim(`\n目录: ${templatesDir()}`));
    return;
  }
  if (s === 'show') {
    if (!name) {
      logger.error('用法: sjn flow template show <名>');
      process.exitCode = 1;
      return;
    }
    const tpl = loadTemplate(name);
    if (!tpl) {
      logger.error(`模板不存在: ${name}`);
      process.exitCode = 1;
      return;
    }
    logger.title(`模板 ${tpl.name}：${tpl.title}`);
    logger.info(chalk.dim(`保存于: ${tpl.savedAt}，共 ${tpl.steps.length} 步`));
    tpl.steps.forEach((step, i) => {
      const danger = step.dangerous ? chalk.yellow(' [不可逆]') : '';
      const deps = step.dependsOn && step.dependsOn.length ? chalk.dim(`  ← ${step.dependsOn.join(', ')}`) : '';
      logger.info(`  ${chalk.bold(`${i + 1}. ${step.title}`)} ${chalk.dim(`(${step.kind})`)}${danger}${deps}`);
    });
    return;
  }
  if (s === 'rm' || s === 'remove' || s === 'del') {
    if (!name) {
      logger.error('用法: sjn flow template rm <名>');
      process.exitCode = 1;
      return;
    }
    if (removeTemplate(name)) logger.success(`已删除模板 ${chalk.bold(name)}`);
    else logger.warn(`模板不存在: ${name}`);
    return;
  }
  logger.error(`未知操作: ${sub}。可用: list / show <名> / rm <名>`);
  process.exitCode = 1;
}

/**
 * 管理已保存工作流：list / show <id> / run <id> / resume <id> / template / log <id>。
 */
async function handleFlow(
  action: string | undefined,
  id: string | undefined,
  arg: string | undefined,
  opts: { dryRun?: boolean; yes?: boolean },
  config: SejuaniConfig
): Promise<void> {
  const act = (action ?? 'list').toLowerCase();
  if (act === 'list') {
    const specs = listSpecs();
    logger.title(`已保存工作流（${specs.length}）`);
    if (specs.length === 0) {
      logger.info(chalk.dim(`  暂无。目录: ${workflowsDir()}`));
      return;
    }
    for (const s of specs) {
      logger.info(
        `  ${chalk.bold(s.id)}  ${s.title}  ${chalk.dim(`[${s.domain}] ${s.steps.length}步 ${s.createdAt}`)}`
      );
    }
    logger.info(chalk.dim(`\n目录: ${workflowsDir()}`));
    return;
  }

  // 模板管理：flow template [list|show <name>|rm <name>]
  if (act === 'template' || act === 'templates' || act === 'tpl') {
    handleFlowTemplate(id, arg);
    return;
  }

  // 运行日志：flow log <id>
  if (act === 'log' || act === 'logs') {
    if (!id) {
      logger.error('用法: sjn flow log <id>（用 sjn flow list 查看 id）');
      process.exitCode = 1;
      return;
    }
    const file = runLogFile(id);
    logger.title(`工作流运行日志 ${id}`);
    logger.info(chalk.dim(`文件: ${file}`));
    const lines = tailRunLog(id, 60);
    if (lines.length === 0) {
      logger.warn('无日志（该工作流尚未执行过，或日志已清理）。');
      return;
    }
    for (const line of lines) logger.info('  ' + chalk.dim(line));
    return;
  }

  // 激活触发器列表：flow triggers
  if (act === 'triggers') {
    const active = listSpecs().filter((s) => s.enabled && s.trigger && s.trigger.type !== 'manual');
    logger.title(`激活的触发器（${active.length}）`);
    if (active.length === 0) {
      logger.info(chalk.dim('  暂无。用 sjn flow enable <id> 激活（spec 需声明 trigger）。'));
      return;
    }
    for (const s of active) {
      const next = computeNextAt(s.trigger!, undefined);
      logger.info(
        `  ${chalk.bold(s.id)}  ${JSON.stringify(s.trigger)}  ${chalk.dim(next ? `下次≈ ${next}` : '事件型')}`
      );
    }
    return;
  }

  // 纯调度前台模式：flow watch（无 HTTP，服务器 nohup 场景）；keepAlive 保活否则进程立即退出
  if (act === 'watch') {
    startScheduler(config, { keepAlive: true });
    logger.success('调度器前台运行中（Ctrl+C 停止）…');
    await new Promise<void>(() => {});
    return;
  }

  // 待批准队列：flow approvals
  if (act === 'approvals') {
    const list = listExecutionsByStatus('waiting-approval');
    logger.title(`待批准执行（${list.length}）`);
    if (list.length === 0) {
      logger.info(chalk.dim('  暂无。无人值守执行命中危险步骤时会挂起到这里。'));
      return;
    }
    for (const e of list) {
      logger.info(
        `  ${chalk.bold(e.execId)}  ${chalk.yellow(`待批：${e.pendingStep?.title ?? '?'} (${e.pendingStep?.kind ?? '?'})`)}  ${chalk.dim(e.startedAt)}`
      );
    }
    logger.info(chalk.dim('\n批准：sjn flow approve <execId>   拒绝：sjn flow reject <execId>'));
    return;
  }

  // 批准/拒绝：flow approve|reject <execId>
  if (act === 'approve' || act === 'reject') {
    if (!id) {
      logger.error(`用法: sjn flow ${act} <execId>（用 sjn flow approvals 查看）`);
      process.exitCode = 1;
      return;
    }
    const exec = findExecution(id);
    if (!exec || exec.status !== 'waiting-approval') {
      logger.error(`未找到待批准执行: ${id}`);
      process.exitCode = 1;
      return;
    }
    if (act === 'reject') {
      exec.status = 'failed';
      exec.endedAt = new Date().toISOString();
      saveExecution(exec);
      logger.success(`已拒绝执行 ${chalk.bold(exec.execId)}（标记 failed）。`);
      return;
    }
    logger.warn(`即将批准执行危险步骤：${exec.pendingStep?.title ?? '?'} (${exec.pendingStep?.kind ?? '?'})`);
    const ok = await runResumeApproved(config, exec.execId);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (!id) {
    logger.error(`操作 ${act} 需要工作流 id。例如: sjn flow ${act} <id>（用 sjn flow list 查看）`);
    process.exitCode = 1;
    return;
  }
  const spec = loadSpec(id);
  if (!spec) {
    logger.error(`未找到工作流: ${id}。用 sjn flow list 查看已保存的工作流。`);
    process.exitCode = 1;
    return;
  }

  switch (act) {
    case 'show': {
      const ctx = await buildStepContext(config, spec, { dryRun: true, yes: !!opts.yes });
      renderWorkflow(spec, ctx);
      return;
    }
    case 'run': {
      const ctx = await buildStepContext(config, spec, { dryRun: !!opts.dryRun, yes: !!opts.yes });
      await runWorkflow(spec, ctx, { dryRun: !!opts.dryRun, yes: !!opts.yes, resume: false, confirm: inquirerConfirm, promptInput: inquirerInput });
      return;
    }
    case 'resume': {
      const ctx = await buildStepContext(config, spec, { dryRun: false, yes: !!opts.yes });
      await runWorkflow(spec, ctx, { dryRun: false, yes: !!opts.yes, resume: true, confirm: inquirerConfirm, promptInput: inquirerInput });
      return;
    }
    case 'enable': {
      if (!spec.trigger || spec.trigger.type === 'manual') {
        logger.error(`工作流 ${id} 未声明触发器（spec.trigger），无法激活。`);
        process.exitCode = 1;
        return;
      }
      if (spec.trigger.type === 'cron') {
        try {
          parseCron(spec.trigger.expr);
        } catch (err) {
          logger.error(`cron 表达式非法：${(err as Error).message}`);
          process.exitCode = 1;
          return;
        }
      }
      spec.enabled = true;
      saveSpec(spec);
      logger.success(`已激活触发器：${chalk.bold(id)} ${JSON.stringify(spec.trigger)}（需 sjn serve 或 sjn flow watch 常驻运行）`);
      return;
    }
    case 'disable': {
      spec.enabled = false;
      saveSpec(spec);
      logger.success(`已停用触发器：${chalk.bold(id)}`);
      return;
    }
    case 'history': {
      const recs = listExecutions(id);
      logger.title(`执行历史 ${id}（${recs.length}）`);
      if (recs.length === 0) {
        logger.info(chalk.dim('  暂无执行存档。'));
        return;
      }
      for (const e of recs) {
        const okSteps = e.state.results?.filter((r) => r.status === 'ok').length ?? 0;
        const tone = e.status === 'ok' ? chalk.green : e.status === 'failed' ? chalk.red : chalk.yellow;
        logger.info(
          `  ${chalk.bold(e.execId)}  ${tone(e.status)}  ${chalk.dim(`${e.trigger.type} · ${okSteps}步ok · ${e.startedAt}${e.endedAt ? ` → ${e.endedAt}` : ''}`)}`
        );
      }
      return;
    }
    case 'save-skill': {
      if (!arg) {
        logger.error('用法: sjn flow save-skill <workflowId> <skillName>');
        process.exitCode = 1;
        return;
      }
      const skill = skillFromWorkflow(spec, { name: arg, title: spec.title });
      try {
        const dir = saveSkill(skill);
        logger.success(`已把工作流 ${id} 固化为技能 ${chalk.bold(arg)} → ${dir}`);
      } catch (err) {
        logger.error((err as Error).message);
        process.exitCode = 1;
      }
      return;
    }
    default:
      logger.error(`未知操作: ${action}。可用: list / show / run / resume / enable / disable / triggers / watch / history / approvals / approve / reject`);
      process.exitCode = 1;
  }
}

/** 批准后以交互模式续跑挂起的执行 */
async function runResumeApproved(config: SejuaniConfig, execId: string): Promise<boolean> {
  const exec = findExecution(execId);
  if (!exec) return false;
  return resumeExecution(config, exec, {
    unattended: false,
    confirm: inquirerConfirm,
    promptInput: inquirerInput,
  });
}

/** 工作流管理与日志目录命令。 */
export function register(program: Command): void {
  // 工作流管理：list / show <id> / run <id> / resume <id> / template / log <id>
  program
    .command('flow [action] [id] [arg]')
    .description('工作流：list | show/run/resume <id> | enable/disable <id> | triggers | watch | history <id> | approvals | approve/reject <execId> | template | log <id>')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('--dry-run', 'run/show：仅预览不执行', false)
    .option('-y, --yes', 'run/resume：跳过确认', false)
    .action(async (action: string | undefined, id: string | undefined, arg: string | undefined, opts) => {
      const config = loadConfig(opts.config);
      await handleFlow(action, id, arg, opts, config);
    });

  // 日志目录：打印 NDJSON 日志存放位置
  program
    .command('logs')
    .description('打印 sejuani 日志目录（每日 NDJSON + 每次运行日志）')
    .action(() => {
      logger.title('sejuani 日志');
      logger.info(`  每日日志目录: ${chalk.cyan(logsDir())}`);
      logger.info(`  每次运行日志: ${chalk.cyan(workflowsDir())}/<id>.run.log`);
      logger.info(chalk.dim('\n查看某次运行原文: sjn flow log <id>'));
    });
}
