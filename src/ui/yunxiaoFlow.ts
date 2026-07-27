import path from 'path';
import { chalk, logger } from '../utils/logger';
import { inquirerConfirm, inquirerInput } from './prompt';
import { loadConfig } from '../core/config';
import { SejuaniConfig } from '../core/config';
import { catalogFromComponents } from '../core/catalog';
import { yunxiaoConfigured } from '../core/state/yunxiaoConfig';
import { CoderTool, getCoderConfig } from '../core/state/coderConfig';
import * as yunxiao from '../core/yunxiao/api';
import { transitionWorkItem } from '../core/yunxiao/transitions';
import { ListQuery, WorkItem, WorkItemComment, WorkItemType } from '../core/yunxiao/types';
import * as git from '../core/git';
import { genWorkflowId } from '../core/workflow/planner';
import { buildFixBugSpec } from '../core/workflow/fixBug';
import { runWorkflow } from '../core/workflow/engine';
import { startRunLog, endRunLog } from '../utils/fileLogger';
import { StepContext } from '../core/workflow/types';

/**
 * 云效功能的共享编排与展示层：供 CLI（issue/fix）与向导（flowYunxiao/flowFix）复用。
 * - 工单列表/详情的表格化展示；
 * - runFixFlow：组织上下文 → 构造 fix-bug 工作流 → 交 engine 执行。
 */

/** 未配置云效时统一提示，返回 false。 */
export function ensureYunxiaoConfigured(): boolean {
  if (yunxiaoConfigured()) return true;
  logger.error('尚未配置云效。请先执行： sjn yunxiao-config set-token <token> 与 set-org <组织id>。');
  logger.hint('（也可用环境变量 YUNXIAO_TOKEN / YUNXIAO_ORG_ID。）');
  return false;
}

/** 类型筛选值（CLI --type）→ 归一枚举。 */
export function parseTypeFilter(raw?: string): WorkItemType | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === 'bug' || s === '缺陷') return 'Bug';
  if (s === 'req' || s === '需求') return 'Req';
  if (s === 'task' || s === '任务') return 'Task';
  return undefined;
}

/** 表格化打印工单列表。 */
export function printIssueList(items: WorkItem[]): void {
  logger.section(`云效工单（${items.length}）`);
  if (items.length === 0) {
    logger.item(chalk.dim('（无匹配工单）'));
    return;
  }
  const rows = items.map((w) => [
    chalk.cyan(w.identifier),
    yunxiao.typeLabel(w.type),
    w.subject,
    w.statusName || chalk.dim('?'),
    w.assignedTo || chalk.dim('-'),
  ]);
  logger.table(['编号', '类型', '标题', '状态', '负责人'], rows);
}

/** 打印单个工单详情与最近评论。 */
export function printIssueDetail(issue: WorkItem, comments: WorkItemComment[]): void {
  logger.section(`工单 ${issue.identifier}`);
  logger.keyValue([
    ['标题', issue.subject],
    ['类型', yunxiao.typeLabel(issue.type)],
    ['状态', issue.statusName || '?'],
    ['负责人', issue.assignedTo || '-'],
  ]);
  if (issue.description && issue.description.trim()) {
    logger.section('描述');
    logger.item(issue.description.trim());
  }
  logger.section(`评论（${comments.length}）`);
  if (comments.length === 0) {
    logger.item(chalk.dim('（暂无评论）'));
  } else {
    for (const c of comments.slice(-10)) {
      logger.bullet(`${chalk.dim(c.createdAt)} ${chalk.cyan(c.author || '?')}：${c.content}`);
    }
  }
}

/** 组合列表查询 + 展示。返回列表供调用方后续选择。 */
export async function queryIssues(query: ListQuery): Promise<WorkItem[]> {
  const items = await yunxiao.listWorkItems(query);
  printIssueList(items);
  return items;
}

/** 看板状态分组顺序（硬编码优先级）。 */
const STATUS_ORDER = ['待处理', '开发中', '待测试', '已完成'];

function statusGroup(name: string): string {
  for (const s of STATUS_ORDER) {
    if (name.includes(s)) return s;
  }
  return name || '其他';
}

/**
 * 看板式打印工单列表：按状态分组展示，带标题头（迭代/负责人）。
 * 返回分组后的 Map 供调用方二次使用。
 */
export function printBoard(
  items: WorkItem[],
  opts?: { sprintName?: string; assigneeName?: string }
): Map<string, WorkItem[]> {
  const header: string[] = [];
  if (opts?.sprintName) header.push(`迭代: ${chalk.cyan(opts.sprintName)}`);
  if (opts?.assigneeName) header.push(`负责人: ${chalk.cyan(opts.assigneeName)}`);
  if (header.length) logger.info(chalk.dim(`── ${header.join(' · ')} ──`));

  if (items.length === 0) {
    logger.info(chalk.dim('  （无匹配工单）'));
    return new Map();
  }

  // 分组
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const g = statusGroup(item.statusName);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(item);
  }

  // 按固定顺序输出
  const orderedKeys = [...STATUS_ORDER.filter((s) => groups.has(s)), ...([...groups.keys()].filter((k) => !STATUS_ORDER.includes(k)))];
  for (const key of orderedKeys) {
    const list = groups.get(key)!;
    logger.info('');
    logger.info(chalk.bold(`${key} (${list.length})`));
    for (const w of list) {
      logger.info(
        `  ${chalk.cyan(w.identifier)}  ${yunxiao.typeLabel(w.type)}  ${w.subject}  ${chalk.dim(w.assignedTo || '-')}`
      );
    }
  }
  logger.info('');
  return groups;
}

/**
 * 快速流转工单状态（供 CLI `task do/done` 用）：核心逻辑在 core/yunxiao/transitions，
 * 这里只负责把结果翻译成终端输出。成功返回 true，失败打 error 并返回 false。
 */
export async function quickTransition(issueId: string, targetStatusName: string): Promise<boolean> {
  const res = await transitionWorkItem(issueId, targetStatusName);
  switch (res.status) {
    case 'not-configured':
      ensureYunxiaoConfigured(); // 打印统一的未配置提示
      return false;
    case 'no-such-status':
      logger.error(`目标状态「${res.target}」不在该工单的工作流中：${res.available.join('/') || '(空)'}`);
      return false;
    case 'already':
      logger.info(`工单 ${chalk.cyan(res.identifier)} 已处于「${res.target}」，无需流转。`);
      return true;
    case 'illegal':
      logger.error(`流转不合法：${res.from} ✗→ ${res.target}`);
      return false;
    case 'done':
      logger.success(`${chalk.cyan(res.identifier)} ${res.from} → ${res.target}`);
      return true;
    case 'error':
      logger.error(res.message);
      return false;
  }
}

export interface FixFlowOptions {
  /** 目标工单 id */
  issueId: string;
  /** 目标工程目录 */
  repoDir: string;
  /** 编码工具，缺省用 coderConfig.activeTool */
  coder?: CoderTool;
  /** MR 目标分支，缺省用工程当前分支 */
  targetBranch?: string;
  /** 显式指定云效代码库标识（缺省从 origin 解析） */
  repoId?: string;
  /** 起始/收尾状态名（缺省 开发中 / 待测试） */
  startStatus?: string;
  doneStatus?: string;
  /** 建议关注的文件 */
  files?: string[];
  dryRun?: boolean;
  yes?: boolean;
  /** 覆盖 sejuani.config.json 路径 */
  configPath?: string;
}

/** 组装 fix 流的执行上下文（工单/工程/编码工具 + 空的组件/工程集合）。 */
function buildFixContext(config: SejuaniConfig, issue: WorkItem, opts: FixFlowOptions, coder: CoderTool, targetBranch: string): StepContext {
  return {
    config,
    components: [],
    catalog: catalogFromComponents([]),
    projects: [],
    selectedComponents: [],
    foundProjects: [],
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
    yunxiao: {
      issue,
      repoDir: opts.repoDir,
      coder,
      targetBranch,
      repoId: opts.repoId,
    },
  };
}

/**
 * 运行完整「修复缺陷」工作流。返回是否成功完成（取消/失败返回 false）。
 * 供 CLI `sjn fix` 与向导「AI 修复 bug」共用。
 */
export async function runFixFlow(opts: FixFlowOptions): Promise<boolean> {
  if (!ensureYunxiaoConfigured()) return false;

  const repoDir = path.resolve(opts.repoDir);
  if (!git.isGitRepo(repoDir)) {
    logger.error(`目标目录不是 git 仓库：${repoDir}`);
    return false;
  }

  logger.step(`拉取工单 ${chalk.cyan(opts.issueId)} 详情 ...`);
  let issue: WorkItem;
  try {
    issue = await yunxiao.getWorkItem(opts.issueId);
  } catch (err) {
    logger.error((err as Error).message);
    return false;
  }
  if (issue.type !== 'Bug') {
    logger.warn(`工单 ${issue.identifier} 类型为「${yunxiao.typeLabel(issue.type)}」，非缺陷单，仍将继续。`);
  }

  const coder = opts.coder ?? getCoderConfig().activeTool;
  const targetBranch = opts.targetBranch ?? git.currentBranch(repoDir) ?? 'master';
  const config = loadConfig(opts.configPath);

  const ctx = buildFixContext(config, issue, opts, coder, targetBranch);

  const runId = genWorkflowId('fix');
  const runLogPath = startRunLog(runId);
  logger.info(chalk.dim(`运行日志: ${runLogPath}`));

  const spec = buildFixBugSpec(issue, {
    targetBranch,
    startStatus: opts.startStatus,
    doneStatus: opts.doneStatus,
    files: opts.files,
    id: runId,
    domain: 'fix',
  });

  if (opts.dryRun) {
    await runWorkflow(spec, ctx, { dryRun: true, yes: !!opts.yes, resume: false });
    endRunLog({ dryRun: true });
    return true;
  }

  return runWorkflow(spec, ctx, { dryRun: false, yes: !!opts.yes, resume: false, confirm: inquirerConfirm, promptInput: inquirerInput });
}
