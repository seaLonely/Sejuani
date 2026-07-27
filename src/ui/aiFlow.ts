import inquirer from 'inquirer';
import path from 'path';
import { Component } from '../core/types';
import { SejuaniConfig } from '../core/config';
import { chalk, logger } from '../utils/logger';
import { inquirerConfirm, inquirerInput } from './prompt';
import { resolveScanTarget } from '../core/config';
import { discoverComponents } from '../core/discover';
import { discoverAndSelect } from './select';
import { catalogFromComponents } from '../core/catalog';
import { aiConfigured } from '../core/state/aiConfig';
import { planWorkflow, genWorkflowId } from '../core/workflow/planner';
import { runWorkflow } from '../core/workflow/engine';
import { startRunLog, endRunLog } from '../utils/fileLogger';
import { analyzeImpact, printImpact } from '../core/workflow/impact';
import { applyTemplate, saveTemplate } from '../core/workflow/templates';
import { StepContext, WorkflowSpec } from '../core/workflow/types';

/**
 * AI 工作流编排：选组件 → 收集描述 → planWorkflow → 审阅 → 确认 → runWorkflow。
 * 供 CLI `sjn ai` 与向导「ai 工作流」共用。
 */

export interface AiFlowOptions {
  /** 组件库根目录（覆盖配置） */
  components?: string;
  /** 直接指定扫描目录（优先级最高，用于选组件） */
  dir?: string;
  /** 预先给定的自然语言描述（缺省则交互收集） */
  description?: string;
  /** 套用已存模板（给了则不调 AI，直接按当前选中组件重绑定） */
  template?: string;
  /** 把本次生成的工作流存为模板名 */
  saveTemplate?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** 组装执行上下文：扫描组件库与工程根，构建 catalog。 */
async function buildContext(
  config: SejuaniConfig,
  selected: Component[],
  allComponents: Component[],
  dryRun: boolean,
  yes: boolean
): Promise<StepContext> {
  const projT = resolveScanTarget(config.roots.projects);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  return {
    config,
    components: allComponents,
    catalog: catalogFromComponents(allComponents),
    projects,
    selectedComponents: selected,
    foundProjects: [],
    dryRun,
    yes,
  };
}

/**
 * 运行完整 AI 工作流交互。返回是否成功完成（取消/失败返回 false）。
 */
export async function runAiFlow(config: SejuaniConfig, opts: AiFlowOptions = {}): Promise<boolean> {
  if (!aiConfigured()) {
    logger.error('尚未配置 AI apiKey。请先执行： sjn ai-config set-key <key>（或设置环境变量 OPENAI_API_KEY）。');
    return false;
  }

  // 选组件（组件库根，或 --dir/--components 覆盖）
  const compTarget = opts.dir
    ? { dir: path.resolve(opts.dir) }
    : opts.components
      ? { dir: path.resolve(opts.components) }
      : resolveScanTarget(config.roots.components);
  logger.step(`扫描组件库 ${chalk.cyan(compTarget.dir)} ...`);
  const allComponents = await discoverComponents(compTarget.dir, { maxDepth: (compTarget as any).maxDepth });
  // 复用已扫描结果做多选，避免重复扫描磁盘
  const selected = await discoverAndSelect({ dir: compTarget.dir, components: allComponents, label: '组件库' });
  if (selected.length === 0) {
    logger.warn('未选择任何组件，已取消。');
    return false;
  }

  // 收集描述（套模板时无需描述）
  let description = (opts.description ?? '').trim();
  if (!opts.template && !description) {
    const ans = await inquirer.prompt<{ desc: string }>([
      {
        type: 'input',
        name: 'desc',
        message: '用自然语言描述你要做的工作流（如“升级并发布这些组件，让使用它们的工程升级并安装依赖”）:',
        filter: (v: string) => v.trim(),
      },
    ]);
    description = ans.desc;
  }
  if (!opts.template && !description) {
    logger.warn('未输入描述，已取消。');
    return false;
  }

  const ctx = await buildContext(config, selected, allComponents, !!opts.dryRun, !!opts.yes);

  // 确定性影响域：规划前算出「受影响工程 + 上游波及组件 + 建议发布层序」并展示
  const impact = analyzeImpact(ctx);
  printImpact(impact);

  // 规划前先采番 runId 并开启运行日志，使 AI 请求/响应原文也写入 <id>.run.log；
  // 该 id 会作为 spec.id 复用（planWorkflow/applyTemplate），保证 `sjn flow log <id>` 与之一致。
  const runId = genWorkflowId(config.activeDomain);
  const runLogPath = startRunLog(runId);
  logger.info(chalk.dim(`运行日志: ${runLogPath}`));

  // 规划：给了模板名走纯套用（不调 AI），否则调 AI 规划
  let spec: WorkflowSpec;
  try {
    if (opts.template) {
      logger.step(`套用模板 ${chalk.cyan(opts.template)} 并按当前选中组件重绑定 ...`);
      spec = applyTemplate(opts.template, ctx, runId);
      logger.success(`已套用模板：${chalk.bold(spec.title)}（${spec.steps.length} 步）`);
    } else {
      spec = await planWorkflow(description, ctx, impact, runId);
    }
  } catch (err) {
    endRunLog({ phase: 'plan', error: (err as Error).message });
    logger.error((err as Error).message);
    return false;
  }

  // 可选：把本次生成的工作流存为模板
  if (opts.saveTemplate) {
    try {
      const file = saveTemplate(opts.saveTemplate, spec);
      logger.success(`已保存为模板 ${chalk.bold(opts.saveTemplate)}: ${chalk.dim(file)}`);
      logger.info(chalk.dim(`下次套用: sjn ai --template ${opts.saveTemplate}`));
    } catch (err) {
      logger.error(`保存模板失败: ${(err as Error).message}`);
    }
  }

  // dry-run：仅预览（engine 不会为 dry-run 关闭运行日志，这里显式收尾，保留已捕获的 AI 原文）
  if (opts.dryRun) {
    await runWorkflow(spec, ctx, { dryRun: true, yes: !!opts.yes, resume: false });
    endRunLog({ dryRun: true });
    return true;
  }

  // 审阅 + 确认后执行（正式执行由 engine 复用同一运行日志并负责 endRunLog）
  await runWorkflow(spec, ctx, { dryRun: false, yes: !!opts.yes, resume: false, confirm: inquirerConfirm, promptInput: inquirerInput });
  return true;
}
