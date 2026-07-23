import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';

export interface LinkPlanItem {
  /** 软链接的目标（真实组件目录） */
  target: string;
  /** 软链接路径（虚拟空间内） */
  linkPath: string;
  /** 该链接已存在时的状态 */
  status: 'create' | 'relink' | 'skip-existing-dir';
}

export interface LinkOptions {
  /** 虚拟空间目录 */
  into: string;
  /** 已存在同名链接/文件时是否覆盖 */
  force: boolean;
  dryRun: boolean;
  yes: boolean;
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 生成软链计划 */
export function buildLinkPlan(
  components: Component[],
  into: string,
  force: boolean
): LinkPlanItem[] {
  const absInto = path.resolve(into);
  return components.map((c) => {
    const linkPath = path.join(absInto, c.name);
    let status: LinkPlanItem['status'] = 'create';
    if (fs.existsSync(linkPath) || isSymlink(linkPath)) {
      // 已存在（软链或真实文件/目录）：force 时标记覆盖，否则跳过
      status = force ? 'relink' : 'skip-existing-dir';
    }
    return { target: c.dir, linkPath, status };
  });
}

/**
 * 创建虚拟空间：把选中的组件以软链形式聚合到一个目录，
 * 便于统一查看 / IDE 打开 / 局部操作，而不移动真实文件。
 */
export async function createVirtualSpace(
  components: Component[],
  opts: LinkOptions
): Promise<void> {
  const absInto = path.resolve(opts.into);
  const plan = buildLinkPlan(components, absInto, opts.force);

  logger.title('虚拟空间（软链）计划');
  logger.info(chalk.dim(`目标目录: ${absInto}`));
  for (const item of plan) {
    const rel = path.relative(process.cwd(), item.target) || item.target;
    const tag =
      item.status === 'create'
        ? chalk.green('[新建]')
        : item.status === 'relink'
        ? chalk.yellow('[覆盖]')
        : chalk.dim('[跳过-已存在]');
    logger.info(`  ${tag} ${chalk.cyan(item.linkPath)} → ${chalk.dim(rel)}`);
  }

  const actionable = plan.filter((p) => p.status !== 'skip-existing-dir');
  if (actionable.length === 0) {
    logger.warn('没有可创建的软链（可能都已存在，使用 --force 覆盖）。');
    return;
  }

  if (opts.dryRun) {
    logger.info(chalk.yellow('\n[dry-run] 未创建任何软链。'));
    return;
  }

  if (!opts.yes) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      { type: 'confirm', name: 'confirmed', message: `确认创建 ${actionable.length} 个软链?`, default: false },
    ]);
    if (!confirmed) {
      logger.warn('已取消。');
      return;
    }
  }

  fs.mkdirSync(absInto, { recursive: true });
  let done = 0;
  for (const item of actionable) {
    if (item.status === 'relink') {
      try {
        const st = fs.lstatSync(item.linkPath);
        if (st.isDirectory() && !st.isSymbolicLink()) {
          logger.warn(`跳过真实目录（避免误删）: ${item.linkPath}`);
          continue;
        }
        fs.rmSync(item.linkPath, { force: true });
      } catch {
        /* ignore */
      }
    }
    fs.symlinkSync(item.target, item.linkPath, 'dir');
    done += 1;
  }
  logger.success(`完成: 创建/更新 ${done} 个软链于 ${absInto}`);
}
