import { Command } from 'commander';
import { logger } from '../../utils/logger';
import {
  ensureYunxiaoConfigured,
  parseTypeFilter,
  printIssueDetail,
  printIssueList,
} from '../../ui/yunxiaoFlow';
import * as yunxiao from '../../core/yunxiao/api';
import { ListQuery } from '../../core/yunxiao/types';

interface ListOpts {
  type?: string;
  mine?: boolean;
  status?: string;
  search?: string;
  limit?: string;
  space?: string;
}

/** issue list：按条件拉取工作项并表格化展示。 */
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

/** issue view <id>：展示工作项详情与最近评论。 */
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

/** 注册 issue 命令组（list / view）。 */
export function register(program: Command): void {
  const issue = program.command('issue').description('云效工单：查看与搜索工作项（需求/缺陷/任务）');

  issue
    .command('list')
    .description('列出工作项，可按类型/负责人/状态/关键词过滤')
    .option('--type <type>', '类型过滤：bug | req | task')
    .option('--mine', '只看分配给自己的工单', false)
    .option('--status <status>', '按状态名过滤（本地包含匹配）')
    .option('--search <keyword>', '按关键词过滤（标题/编号）')
    .option('--space <spaceId>', '项目/空间 id（覆盖默认）')
    .option('--limit <n>', '返回条数上限（默认 50）')
    .action(async (opts: ListOpts) => {
      await handleList(opts);
    });

  issue
    .command('view <id>')
    .description('查看单个工作项详情与最近评论')
    .action(async (id: string) => {
      await handleView(id);
    });
}
