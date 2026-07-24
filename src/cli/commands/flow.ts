import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig, resolveScanTarget } from '../../core/configLoader';
import { SejuaniConfig } from '../../config';
import { discoverComponents } from '../../core/discover';
import { catalogFromComponents } from '../../core/catalog';
import { listSpecs, loadSpec, workflowsDir } from '../../core/workflow/store';
import { renderWorkflow, runWorkflow } from '../../core/workflow/engine';
import { listTemplates, loadTemplate, removeTemplate, templatesDir } from '../../core/workflow/templates';
import { runLogFile, tailRunLog, logsDir } from '../../utils/fileLogger';
import { StepContext, WorkflowSpec } from '../../core/workflow/types';

/**
 * 重建执行上下文：扫描组件库与工程根，从 spec 各步 params.components 反推选中组件。
 * 供 flow show / run / resume 复用（脱离原始交互会话）。
 */
async function buildFlowContext(
  config: SejuaniConfig,
  spec: WorkflowSpec,
  dryRun: boolean,
  yes: boolean
): Promise<StepContext> {
  const compT = resolveScanTarget(config.roots.components);
  const projT = resolveScanTarget(config.roots.projects);
  const components = await discoverComponents(compT.dir, { maxDepth: compT.maxDepth });
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  // 从各步 params.components 的并集反推选中组件；缺省用全部组件兜底
  const names = new Set<string>();
  for (const step of spec.steps) {
    const cs = step.params && (step.params as any).components;
    if (Array.isArray(cs)) for (const n of cs) names.add(String(n));
  }
  const selectedComponents =
    names.size > 0
      ? components.filter((c) => (c.pkgName && names.has(c.pkgName)) || names.has(c.name))
      : components;
  return {
    config,
    components,
    catalog: catalogFromComponents(components),
    projects,
    selectedComponents: selectedComponents.length > 0 ? selectedComponents : components,
    foundProjects: [],
    dryRun,
    yes,
  };
}

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
      const ctx = await buildFlowContext(config, spec, true, !!opts.yes);
      renderWorkflow(spec, ctx);
      return;
    }
    case 'run': {
      const ctx = await buildFlowContext(config, spec, !!opts.dryRun, !!opts.yes);
      await runWorkflow(spec, ctx, { dryRun: !!opts.dryRun, yes: !!opts.yes, resume: false });
      return;
    }
    case 'resume': {
      const ctx = await buildFlowContext(config, spec, false, !!opts.yes);
      await runWorkflow(spec, ctx, { dryRun: false, yes: !!opts.yes, resume: true });
      return;
    }
    default:
      logger.error(`未知操作: ${action}。可用: list / show <id> / run <id> / resume <id>`);
      process.exitCode = 1;
  }
}

/** 工作流管理与日志目录命令。 */
export function register(program: Command): void {
  // 工作流管理：list / show <id> / run <id> / resume <id> / template / log <id>
  program
    .command('flow [action] [id] [arg]')
    .description('管理已保存的 AI 工作流：flow list | show <id> | run <id> | resume <id> | template [list|show <n>|rm <n>] | log <id>')
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
