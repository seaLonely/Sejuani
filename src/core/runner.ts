import path from 'path';
import { ComponentChange, ConfirmFn } from './types';
import { backupFile, writeFile } from './backup';
import { renderDiff } from './diff';
import { chalk, logger } from '../utils/logger';

export interface RunOptions {
  /** 只预览不写入 */
  dryRun: boolean;
  /** 写入前是否备份原文件 */
  backup: boolean;
  /** 跳过交互确认（非交互/CI 场景） */
  yes: boolean;
  /** 预览时展示 diff 明细 */
  showDiff: boolean;
  /** 确认回调（yes=false 时生效）；未提供时视为拒绝，不会默默写盘 */
  confirm?: ConfirmFn;
}

export interface RunResult {
  filesChanged: number;
  componentsChanged: number;
  backups: string[];
}

/** 过滤出真正有变化的组件与文件 */
export function keepChanged(changes: ComponentChange[]): ComponentChange[] {
  return changes
    .map((c) => ({ component: c.component, files: c.files.filter((f) => f.after !== f.before) }))
    .filter((c) => c.files.length > 0);
}

/** 把变更列表写入磁盘（可选备份）：无交互的纯执行层，供 runChanges 与 server 路由复用。 */
export function applyChanges(changes: ComponentChange[], backup: boolean): RunResult {
  const backups: string[] = [];
  let filesChanged = 0;
  for (const c of changes) {
    for (const f of c.files) {
      if (backup) backups.push(backupFile(f.filePath));
      writeFile(f.filePath, f.after);
      filesChanged += 1;
    }
  }
  return { filesChanged, componentsChanged: changes.length, backups };
}

function printPreview(changes: ComponentChange[], showDiff: boolean): { files: number } {
  let files = 0;
  logger.title('变更预览');
  for (const c of changes) {
    logger.info(chalk.bold(`\n📦 ${c.component.name}`) + chalk.dim(`  ${c.component.dir}`));
    for (const f of c.files) {
      files += 1;
      logger.info('  ' + chalk.cyan(path.basename(f.filePath)) + '  ' + chalk.dim(f.summary));
      if (showDiff) {
        logger.info(renderDiff(f.before, f.after));
      }
    }
  }
  return { files };
}

/**
 * 统一执行入口：预览 → 确认 → 备份 → 写入。
 * 所有编辑类命令都走这里，保证行为一致、安全。
 */
export async function runChanges(
  rawChanges: ComponentChange[],
  opts: RunOptions
): Promise<RunResult> {
  const changes = keepChanged(rawChanges);

  if (changes.length === 0) {
    logger.warn('没有需要变更的内容。');
    return { filesChanged: 0, componentsChanged: 0, backups: [] };
  }

  const { files } = printPreview(changes, opts.showDiff);
  logger.info(
    '\n' +
      chalk.bold('合计: ') +
      `${changes.length} 个组件, ${files} 个文件将被修改`
  );

  if (opts.dryRun) {
    logger.info(chalk.yellow('\n[dry-run] 未写入任何文件。去掉 --dry-run 或在向导中确认以实际执行。'));
    return { filesChanged: 0, componentsChanged: 0, backups: [] };
  }

  if (!opts.yes) {
    const message = `确认写入以上 ${files} 个文件${opts.backup ? '（将生成 .bak 备份）' : ''}?`;
    const confirmed = opts.confirm ? await opts.confirm(message) : false;
    if (!confirmed) {
      logger.warn('已取消，未做任何修改。');
      return { filesChanged: 0, componentsChanged: 0, backups: [] };
    }
  }

  const result = applyChanges(changes, opts.backup);

  logger.success(
    `完成: 修改 ${result.filesChanged} 个文件${opts.backup ? `, 生成 ${result.backups.length} 个备份` : ''}。`
  );
  return result;
}
