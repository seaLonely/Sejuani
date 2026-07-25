import inquirer from 'inquirer';
import path from 'path';
import { chalk, logger } from '../../utils/logger';
import {
  ensureYunxiaoConfigured,
  printBoard,
  printIssueDetail,
  printIssueList,
} from '../yunxiaoFlow';
import { runFixFlow } from '../yunxiaoFlow';
import * as yunxiao from '../../core/yunxiao/api';
import { ListQuery, WorkItem } from '../../core/yunxiao/types';
import { getYunxiaoConfig, setYunxiaoConfig } from '../../core/yunxiaoConfig';
import { CODER_TOOLS, CoderTool, getCoderConfig } from '../../core/coderConfig';

// ─── 首次引导 ─────────────────────────────────────────────────────

/**
 * 若 defaultSprintId 和 defaultAssigneeId 都为空，触发首次快速设置。
 * 返回 true 表示继续进入看板（含跳过），false 表示用户取消/出错。
 */
async function maybeFirstTimeSetup(): Promise<boolean> {
  const cfg = getYunxiaoConfig();
  if (cfg.defaultSprintId || cfg.defaultAssigneeId) return true; // 已有默认值

  logger.info(chalk.yellow('检测到尚未设置默认迭代/负责人，建议先设置以获得最佳看板体验。'));
  const { op } = await inquirer.prompt<{ op: 'setup' | 'skip' }>([
    {
      type: 'list',
      name: 'op',
      message: '快速设置:',
      choices: [
        { name: '设置（选择迭代和负责人）', value: 'setup' },
        { name: '跳过，直接显示全部工单', value: 'skip' },
      ],
    },
  ]);
  if (op === 'skip') return true;

  try {
    // 迭代选择
    const sprints = await yunxiao.listSprints();
    if (sprints.length > 0) {
      const { id } = await inquirer.prompt<{ id: string }>([
        {
          type: 'list',
          name: 'id',
          message: '选择默认迭代:',
          pageSize: 15,
          loop: false,
          choices: [
            { name: chalk.dim('（不设置）'), value: '' },
            ...sprints.map((s) => ({
              name: `${s.name}  ${chalk.dim(s.status)}`,
              value: s.id,
            })),
          ],
        },
      ]);
      if (id) {
        const picked = sprints.find((s) => s.id === id);
        setYunxiaoConfig({ defaultSprintId: id, defaultSprintName: picked?.name });
        logger.success(`默认迭代: ${picked?.name ?? id}`);
      }
    }

    // 负责人选择
    const members = await yunxiao.listProjectMembers();
    if (members.length > 0) {
      const { id } = await inquirer.prompt<{ id: string }>([
        {
          type: 'list',
          name: 'id',
          message: '选择默认负责人（筛选工单）:',
          pageSize: 15,
          loop: false,
          choices: [
            { name: chalk.dim('（不设置）'), value: '' },
            ...members.map((m) => ({
              name: m.role ? `${m.name}  ${chalk.dim(m.role)}` : m.name,
              value: m.id,
            })),
          ],
        },
      ]);
      if (id) {
        const picked = members.find((m) => m.id === id);
        setYunxiaoConfig({ defaultAssigneeId: id, defaultAssigneeName: picked?.name });
        logger.success(`默认负责人: ${picked?.name ?? id}`);
      }
    }
  } catch (err) {
    logger.error(`设置失败：${(err as Error).message}`);
    // 仍继续进入看板
  }
  return true;
}

// ─── 操作菜单 ─────────────────────────────────────────────────────

/**
 * 选中工单后的操作菜单循环。
 * 返回 'back' 时回到看板。
 */
async function actionMenu(issue: WorkItem): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    logger.info('');
    logger.info(
      `${chalk.cyan(issue.identifier)} · ${issue.subject} · ${chalk.bold(issue.statusName || '?')}`
    );

    type Op = 'transition' | 'comment' | 'fix' | 'detail' | 'back';
    const choices: { name: string; value: Op }[] = [
      { name: `流转状态（${issue.statusName} → ...）`, value: 'transition' },
      { name: '追加评论', value: 'comment' },
    ];
    if (issue.type === 'Bug') {
      choices.push({ name: 'AI 修复（本地 AI → MR）', value: 'fix' });
    }
    choices.push(
      { name: '查看详情与评论', value: 'detail' },
      { name: chalk.dim('↩ 返回看板'), value: 'back' }
    );

    const { op } = await inquirer.prompt<{ op: Op }>([
      { type: 'list', name: 'op', message: '操作:', loop: false, choices },
    ]);

    if (op === 'back') return;

    if (op === 'transition') {
      await doTransition(issue);
    } else if (op === 'comment') {
      await doComment(issue);
    } else if (op === 'fix') {
      await doFix(issue);
    } else if (op === 'detail') {
      try {
        const full = await yunxiao.getWorkItem(issue.id);
        const comments = await yunxiao.listComments(issue.id);
        printIssueDetail(full, comments);
        // 刷新本地 issue 对象
        issue.statusName = full.statusName;
        issue.statusId = full.statusId;
        issue.assignedTo = full.assignedTo;
      } catch (err) {
        logger.error((err as Error).message);
      }
    }
  }
}

/** 流转状态操作。 */
async function doTransition(issue: WorkItem): Promise<void> {
  try {
    const statuses = await yunxiao.listWorkflowStatuses(issue.spaceId, issue.type);
    if (statuses.length === 0) {
      logger.warn('未获取到工作流状态列表。');
      return;
    }
    const { targetId } = await inquirer.prompt<{ targetId: string }>([
      {
        type: 'list',
        name: 'targetId',
        message: `当前: ${issue.statusName}，流转到:`,
        loop: false,
        pageSize: 10,
        choices: [
          { name: chalk.dim('（取消）'), value: '' },
          ...statuses
            .filter((s) => s.id !== issue.statusId)
            .map((s) => ({ name: s.name, value: s.id })),
        ],
      },
    ]);
    if (!targetId) return;
    const target = statuses.find((s) => s.id === targetId);
    await yunxiao.updateWorkItemStatus(issue.id, targetId);
    issue.statusId = targetId;
    issue.statusName = target?.name ?? issue.statusName;
    logger.success(`已流转: ${chalk.cyan(issue.identifier)} → ${issue.statusName}`);
  } catch (err) {
    logger.error((err as Error).message);
  }
}

/** 追加评论操作。 */
async function doComment(issue: WorkItem): Promise<void> {
  const { content } = await inquirer.prompt<{ content: string }>([
    { type: 'input', name: 'content', message: '评论内容:', filter: (v: string) => v.trim() },
  ]);
  if (!content) {
    logger.warn('评论为空，已取消。');
    return;
  }
  try {
    await yunxiao.addComment(issue.id, content);
    logger.success('评论已提交。');
  } catch (err) {
    logger.error((err as Error).message);
  }
}

/** AI 修复操作（仅 Bug）。复用 runFixFlow，跳过工单选择。 */
async function doFix(issue: WorkItem): Promise<void> {
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

  logger.section('工作流预览（dry-run）');
  await runFixFlow({
    issueId: issue.id,
    repoDir: dir,
    coder,
    targetBranch: targetBranch || undefined,
    dryRun: true,
  });

  const { go } = await inquirer.prompt<{ go: boolean }>([
    { type: 'confirm', name: 'go', message: '确认执行以上工作流?', default: false },
  ]);
  if (!go) {
    logger.info('已取消。');
    return;
  }

  await runFixFlow({
    issueId: issue.id,
    repoDir: dir,
    coder,
    targetBranch: targetBranch || undefined,
    dryRun: false,
  });
}

// ─── 看板主流程 ───────────────────────────────────────────────────

/**
 * 任务看板：一步直达当前迭代的工单，按状态分组展示，选中即可操作。
 * 替代旧版 flowYunxiao 成为主工单入口。
 */
export async function flowTaskBoard(): Promise<void> {
  if (!ensureYunxiaoConfigured()) return;

  // 首次引导
  const ok = await maybeFirstTimeSetup();
  if (!ok) return;

  // 看板主循环
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cfg = getYunxiaoConfig();
    const query: ListQuery = { limit: 100 }; // 看板拉多一些

    logger.section('任务看板');
    let items: WorkItem[];
    try {
      items = await yunxiao.listWorkItems(query);
    } catch (err) {
      logger.error((err as Error).message);
      return;
    }

    printBoard(items, {
      sprintName: cfg.defaultSprintName,
      assigneeName: cfg.defaultAssigneeName,
    });

    if (items.length === 0) {
      const { op } = await inquirer.prompt<{ op: 'settings' | 'back' }>([
        {
          type: 'list',
          name: 'op',
          message: '操作:',
          choices: [
            { name: '修改默认设置（迭代/负责人）', value: 'settings' },
            { name: '↩ 退出', value: 'back' },
          ],
        },
      ]);
      if (op === 'settings') {
        await flowYunxiaoSettings();
        continue;
      }
      return;
    }

    // 选择器：工单 + 辅助操作
    const { picked } = await inquirer.prompt<{ picked: string }>([
      {
        type: 'list',
        name: 'picked',
        message: '选择工单操作，或:',
        pageSize: Math.min(items.length + 5, 20),
        loop: false,
        choices: [
          ...items.map((w) => ({
            name: `${chalk.cyan(w.identifier)}  ${w.subject}  ${chalk.dim(w.statusName || '?')}`,
            value: w.id,
          })),
          new inquirer.Separator(),
          { name: '修改默认设置（迭代/团队/负责人）', value: '__settings__' },
          { name: '不应用默认，显示全部', value: '__all__' },
          { name: chalk.dim('↩ 退出'), value: '__quit__' },
        ],
      },
    ]);

    if (picked === '__quit__') return;
    if (picked === '__settings__') {
      await flowYunxiaoSettings();
      continue;
    }
    if (picked === '__all__') {
      // 一次性显示全部（不循环，展示后回到看板）
      try {
        const all = await yunxiao.listWorkItems({ applyDefaults: false, limit: 100 });
        printIssueList(all);
      } catch (err) {
        logger.error((err as Error).message);
      }
      continue;
    }

    // 选中了具体工单
    const issue = items.find((w) => w.id === picked);
    if (issue) {
      await actionMenu(issue);
    }
  }
}

// ─── flowYunxiao 兼容导出 ─────────────────────────────────────────

/**
 * 向导「工单管理」入口（兼容旧导出名）。
 * 现在直接指向任务看板。
 */
export const flowYunxiao = flowTaskBoard;

// ─── flowFix（保持原样）─────────────────────────────────────────

/**
 * 向导「AI 修复 bug」：列出我的缺陷单供选择 → 选本地工程目录 → 选编码工具 →
 * 预览 fix-bug 工作流（dry-run）→ 确认后执行，实时输出进度与 MR 链接。
 */
export async function flowFix(): Promise<void> {
  if (!ensureYunxiaoConfigured()) return;

  // 拉取缺陷单（应用默认迭代/负责人筛选）
  let bugs: WorkItem[];
  try {
    bugs = await yunxiao.listWorkItems({ type: 'Bug' });
  } catch (err) {
    logger.error((err as Error).message);
    return;
  }
  if (bugs.length === 0) {
    logger.warn('没有匹配的缺陷单。可用「任务看板」浏览全部工单。');
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

// ─── flowYunxiaoSettings（保持原样）───────────────────────────────

/** 打印当前云效默认设置（迭代/团队/负责人）。 */
function printCurrentDefaults(): void {
  const c = getYunxiaoConfig();
  const fmt = (name?: string, id?: string) =>
    id ? chalk.cyan(name ? `${name} (${id})` : id) : chalk.dim('(未设置)');
  logger.info(`  默认迭代:   ${fmt(c.defaultSprintName, c.defaultSprintId)}`);
  logger.info(`  默认团队:   ${fmt(c.defaultTeamName, c.defaultTeamId)}`);
  logger.info(`  默认负责人: ${fmt(c.defaultAssigneeName, c.defaultAssigneeId)}`);
}

/**
 * 向导「云效默认设置」：按列表选择默认迭代 / 团队(部门) / 负责人并持久化。
 */
export async function flowYunxiaoSettings(): Promise<void> {
  if (!ensureYunxiaoConfigured()) return;

  logger.section('当前云效默认设置');
  printCurrentDefaults();

  const { op } = await inquirer.prompt<{ op: 'sprint' | 'team' | 'assignee' | 'clear' | 'back' }>([
    {
      type: 'list',
      name: 'op',
      message: '设置项:',
      loop: false,
      choices: [
        { name: '设置默认迭代（Sprint，用于筛选工单）', value: 'sprint' },
        { name: '设置默认团队（组织部门）', value: 'team' },
        { name: '设置默认负责人（用于筛选工单）', value: 'assignee' },
        { name: '清空全部默认', value: 'clear' },
        new inquirer.Separator(),
        { name: chalk.dim('↩ 返回'), value: 'back' },
      ],
    },
  ]);
  if (op === 'back') return;

  if (op === 'clear') {
    setYunxiaoConfig({
      defaultSprintId: undefined,
      defaultSprintName: undefined,
      defaultTeamId: undefined,
      defaultTeamName: undefined,
      defaultAssigneeId: undefined,
      defaultAssigneeName: undefined,
    });
    logger.success('已清空云效默认迭代/团队/负责人。');
    return;
  }

  try {
    if (op === 'sprint') {
      const sprints = await yunxiao.listSprints();
      if (sprints.length === 0) {
        logger.warn('该项目下没有可选迭代。');
        return;
      }
      const { id } = await inquirer.prompt<{ id: string }>([
        {
          type: 'list',
          name: 'id',
          message: '选择默认迭代:',
          pageSize: 15,
          loop: false,
          choices: [
            { name: chalk.dim('（不设置 / 清空）'), value: '' },
            ...sprints.map((s) => ({
              name: `${s.name}  ${chalk.dim(s.status)}`,
              value: s.id,
            })),
          ],
        },
      ]);
      const picked = sprints.find((s) => s.id === id);
      setYunxiaoConfig({ defaultSprintId: id || undefined, defaultSprintName: picked?.name });
      logger.success(id ? `已设置默认迭代：${picked?.name ?? id}` : '已清空默认迭代。');
    } else if (op === 'team') {
      const depts = await yunxiao.listDepartments();
      if (depts.length === 0) {
        logger.warn('未获取到组织部门。');
        return;
      }
      const { id } = await inquirer.prompt<{ id: string }>([
        {
          type: 'list',
          name: 'id',
          message: '选择默认团队(部门):',
          pageSize: 15,
          loop: false,
          choices: [
            { name: chalk.dim('（不设置 / 清空）'), value: '' },
            ...depts.map((d) => ({ name: d.name, value: d.id })),
          ],
        },
      ]);
      const picked = depts.find((d) => d.id === id);
      setYunxiaoConfig({ defaultTeamId: id || undefined, defaultTeamName: picked?.name });
      logger.success(id ? `已设置默认团队：${picked?.name ?? id}` : '已清空默认团队。');
    } else {
      const members = await yunxiao.listProjectMembers();
      if (members.length === 0) {
        logger.warn('未获取到项目成员。');
        return;
      }
      const { id } = await inquirer.prompt<{ id: string }>([
        {
          type: 'list',
          name: 'id',
          message: '选择默认负责人:',
          pageSize: 15,
          loop: false,
          choices: [
            { name: chalk.dim('（不设置 / 清空）'), value: '' },
            ...members.map((m) => ({
              name: m.role ? `${m.name}  ${chalk.dim(m.role)}` : m.name,
              value: m.id,
            })),
          ],
        },
      ]);
      const picked = members.find((m) => m.id === id);
      setYunxiaoConfig({ defaultAssigneeId: id || undefined, defaultAssigneeName: picked?.name });
      logger.success(id ? `已设置默认负责人：${picked?.name ?? id}` : '已清空默认负责人。');
    }
  } catch (err) {
    logger.error((err as Error).message);
    return;
  }

  logger.section('更新后的云效默认设置');
  printCurrentDefaults();
}
