import { Command } from 'commander';
import { logger } from '../../utils/logger';
import {
  ensureYunxiaoConfigured,
  parseTypeFilter,
  printIssueDetail,
  printIssueList,
  quickTransition,
} from '../../ui/yunxiaoFlow';
import { flowTaskBoard } from '../../ui/wizard/yunxiao';
import * as yunxiao from '../../core/yunxiao/api';
import { ListQuery } from '../../core/yunxiao/types';

interface ListOpts {
  type?: string;
  mine?: boolean;
  status?: string;
  search?: string;
  limit?: string;
  space?: string;
  sprint?: string;
  defaults?: boolean;
}

/** task list：非交互列表（复用 issue list 逻辑）。 */
async function handleList(opts: ListOpts): Promise<void> {
  if (!ensureYunxiaoConfigured()) {
    process.exitCode = 1;
    return;
  }
  const query: ListQuery = {
    type: parseTypeFilter(opts.type),
    keyword: opts.search,
    statusName: opts.status,
    spaceId: opts.space,
    sprintId: opts.sprint,
    applyDefaults: opts.defaults,
    limit: opts.limit ? Number(opts.limit) : undefined,
  };
  if (opts.mine) {
    try {
      const me = await yunxiao.getCurrentUser();
      query.assignedToId = me.id;
      logger.info(`只看分配给：${me.name || me.id}`);
    } catch (err) {
      logger.error(`获取当前用户失败：${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  try {
    const items = await yunxiao.listWorkItems(query);
    printIssueList(items);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  }
}

/** task view <id>：查看详情。 */
async function handleView(id: string): Promise<void> {
  if (!ensureYunxiaoConfigured()) {
    process.exitCode = 1;
    return;
  }
  try {
    const issue = await yunxiao.getWorkItem(id);
    const comments = await yunxiao.listComments(issue.id);
    printIssueDetail(issue, comments);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  }
}

/** task do <id>：快速流转到「开发中」。 */
async function handleDo(id: string): Promise<void> {
  const ok = await quickTransition(id, '开发中');
  if (!ok) process.exitCode = 1;
}

/** task done <id>：快速流转到「待测试」。 */
async function handleDone(id: string): Promise<void> {
  const ok = await quickTransition(id, '待测试');
  if (!ok) process.exitCode = 1;
}

/** 注册 task 命令组。 */
export function register(program: Command): void {
  const task = program
    .command('task')
    .description('任务看板：交互式管理云效工单（查看/流转/评论）')
    .action(async () => {
      await flowTaskBoard();
    });

  task
    .command('list')
    .description('列出工作项（非交互），支持按类型/迭代/状态等过滤')
    .option('--type <type>', '类型过滤：bug | req | task')
    .option('--mine', '只看分配给自己的工单', false)
    .option('--status <status>', '按状态名过滤（本地包含匹配）')
    .option('--search <keyword>', '按关键词过滤（标题/编号）')
    .option('--space <spaceId>', '项目/空间 id（覆盖默认）')
    .option('--sprint <sprintId>', '按迭代 id 过滤（覆盖默认迭代）')
    .option('--no-defaults', '本次忽略配置的默认迭代/负责人')
    .option('--limit <n>', '返回条数上限（默认 50）')
    .action(async (opts: ListOpts) => {
      await handleList(opts);
    });

  task
    .command('view <id>')
    .description('查看单个工作项详情与评论')
    .action(async (id: string) => {
      await handleView(id);
    });

  task
    .command('do <id>')
    .description('快速流转工单到「开发中」')
    .action(async (id: string) => {
      await handleDo(id);
    });

  task
    .command('done <id>')
    .description('快速流转工单到「待测试」')
    .action(async (id: string) => {
      await handleDone(id);
    });
}
