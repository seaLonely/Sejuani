import inquirer from 'inquirer';
import path from 'path';
import { chalk, logger } from '../../utils/logger';
import {
  ensureYunxiaoConfigured,
  parseTypeFilter,
  printIssueDetail,
  printIssueList,
} from '../yunxiaoFlow';
import { runFixFlow } from '../yunxiaoFlow';
import * as yunxiao from '../../core/yunxiao/api';
import { ListQuery, WorkItem } from '../../core/yunxiao/types';
import { CODER_TOOLS, CoderTool, getCoderConfig } from '../../core/coderConfig';

/**
 * 向导「工单管理」：按类型/只看我的/关键词搜索拉取工单，表格展示，
 * 并可选中某单查看详情与评论。未配置云效时引导去 yunxiao-config。
 */
export async function flowYunxiao(): Promise<void> {
  if (!ensureYunxiaoConfigured()) return;

  const { mode } = await inquirer.prompt<{ mode: 'all' | 'type' | 'mine' | 'search' }>([
    {
      type: 'list',
      name: 'mode',
      message: '工单查询方式:',
      choices: [
        { name: '全部工单', value: 'all' },
        { name: '按类型（需求/缺陷/任务）', value: 'type' },
        { name: '只看分配给我的', value: 'mine' },
        { name: '关键词搜索', value: 'search' },
      ],
    },
  ]);

  const query: ListQuery = {};
  if (mode === 'type') {
    const { type } = await inquirer.prompt<{ type: string }>([
      {
        type: 'list',
        name: 'type',
        message: '选择类型:',
        choices: [
          { name: '缺陷 (bug)', value: 'bug' },
          { name: '需求 (req)', value: 'req' },
          { name: '任务 (task)', value: 'task' },
        ],
      },
    ]);
    query.type = parseTypeFilter(type);
  } else if (mode === 'mine') {
    try {
      const me = await yunxiao.getCurrentUser();
      query.assignedToId = me.id;
      logger.info(`只看分配给：${me.name || me.id}`);
    } catch (err) {
      logger.error(`获取当前用户失败：${(err as Error).message}`);
      return;
    }
  } else if (mode === 'search') {
    const { kw } = await inquirer.prompt<{ kw: string }>([
      { type: 'input', name: 'kw', message: '关键词（标题/编号）:', filter: (v: string) => v.trim() },
    ]);
    query.keyword = kw || undefined;
  }

  let items: WorkItem[];
  try {
    items = await yunxiao.listWorkItems(query);
  } catch (err) {
    logger.error((err as Error).message);
    return;
  }
  printIssueList(items);
  if (items.length === 0) return;

  const { pickId } = await inquirer.prompt<{ pickId: string }>([
    {
      type: 'list',
      name: 'pickId',
      message: '查看某工单详情?（或返回）',
      pageSize: 15,
      choices: [
        { name: chalk.dim('↩ 返回'), value: '' },
        ...items.map((w) => ({
          name: `${chalk.cyan(w.identifier)}  ${w.subject}  ${chalk.dim(w.statusName || '?')}`,
          value: w.id,
        })),
      ],
    },
  ]);
  if (!pickId) return;
  try {
    const issue = await yunxiao.getWorkItem(pickId);
    const comments = await yunxiao.listComments(issue.id);
    printIssueDetail(issue, comments);
  } catch (err) {
    logger.error((err as Error).message);
  }
}

/**
 * 向导「AI 修复 bug」：列出我的缺陷单供选择 → 选本地工程目录 → 选编码工具 →
 * 预览 fix-bug 工作流（dry-run）→ 确认后执行，实时输出进度与 MR 链接。
 */
export async function flowFix(): Promise<void> {
  if (!ensureYunxiaoConfigured()) return;

  // 拉取我的缺陷单
  let bugs: WorkItem[];
  try {
    const me = await yunxiao.getCurrentUser();
    bugs = await yunxiao.listWorkItems({ type: 'Bug', assignedToId: me.id });
  } catch (err) {
    logger.error((err as Error).message);
    return;
  }
  if (bugs.length === 0) {
    logger.warn('没有分配给你的缺陷单。可用「工单管理」浏览全部工单。');
    return;
  }
  printIssueList(bugs);

  const { issueId } = await inquirer.prompt<{ issueId: string }>([
    {
      type: 'list',
      name: 'issueId',
      message: '选择要修复的缺陷单:',
      pageSize: 15,
      choices: bugs.map((w) => ({
        name: `${chalk.cyan(w.identifier)}  ${w.subject}  ${chalk.dim(w.statusName || '?')}`,
        value: w.id,
      })),
    },
  ]);

  const activeTool = getCoderConfig().activeTool;
  const { dir, coder, targetBranch } = await inquirer.prompt<{
    dir: string;
    coder: CoderTool;
    targetBranch: string;
  }>([
    {
      type: 'input',
      name: 'dir',
      message: '目标工程代码目录:',
      default: process.cwd(),
      filter: (v: string) => path.resolve(v.trim()),
    },
    {
      type: 'list',
      name: 'coder',
      message: '本地 AI 编码工具:',
      default: activeTool,
      choices: CODER_TOOLS.map((t) => ({ name: t === activeTool ? `${t}（默认）` : t, value: t })),
    },
    {
      type: 'input',
      name: 'targetBranch',
      message: 'MR 目标分支（留空=工程当前分支）:',
      filter: (v: string) => v.trim(),
    },
  ]);

  // 先干跑预览工作流
  logger.section('工作流预览（dry-run）');
  await runFixFlow({
    issueId,
    repoDir: dir,
    coder,
    targetBranch: targetBranch || undefined,
    dryRun: true,
  });

  const { go } = await inquirer.prompt<{ go: boolean }>([
    { type: 'confirm', name: 'go', message: '确认执行以上工作流?（危险步骤会再次确认）', default: false },
  ]);
  if (!go) {
    logger.info('已取消。');
    return;
  }

  await runFixFlow({
    issueId,
    repoDir: dir,
    coder,
    targetBranch: targetBranch || undefined,
    dryRun: false,
  });
}
