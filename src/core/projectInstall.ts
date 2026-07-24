import { Component } from '../types';
import { runCommand } from './exec';
import { chalk, logger } from '../utils/logger';

/**
 * 工程装依赖原语：对每个工程执行 yarn/npm install（实时输出），逐个容错并汇总。
 * 复用 release/sync 的汇总风格，供工作流 project.install 步骤使用。
 */

export type PackageManager = 'yarn' | 'npm';

export interface InstallOptions {
  /** 包管理器，默认 yarn */
  pm?: PackageManager;
  /** 仅打印将执行的命令不实际执行 */
  dryRun?: boolean;
}

export interface InstallItemResult {
  project: string;
  dir: string;
  ok: boolean;
  reason?: string;
}

export interface InstallSummary {
  results: InstallItemResult[];
  okCount: number;
  failed: InstallItemResult[];
}

/** 逐工程执行 <pm> install。返回汇总结果（不抛错，失败信息在 results 里）。 */
export function installProjects(projects: Component[], opts: InstallOptions = {}): InstallSummary {
  const pm: PackageManager = opts.pm ?? 'yarn';
  const results: InstallItemResult[] = [];

  logger.title(`工程装依赖计划（${pm} install）`);
  for (const p of projects) {
    logger.info('  ' + chalk.cyan(p.pkgName ?? p.name) + chalk.dim(`  ${p.dir}`));
  }

  if (opts.dryRun) {
    logger.info(chalk.yellow('\n[dry-run] 未实际执行。'));
    return { results: [], okCount: 0, failed: [] };
  }

  let done = 0;
  for (const p of projects) {
    logger.step(`[${++done}/${projects.length}] ${pm} install ${chalk.dim(`(cwd: ${p.dir})`)}`);
    const r = runCommand(pm, ['install'], { cwd: p.dir, inherit: true });
    if (r.ok) {
      results.push({ project: p.name, dir: p.dir, ok: true });
      logger.success(`  完成 ${p.name}`);
    } else {
      results.push({ project: p.name, dir: p.dir, ok: false, reason: `install 失败: exit ${r.code}` });
      logger.error(`  ${p.name} install 失败（exit ${r.code}）`);
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  logger.title('工程装依赖结果');
  logger.success(`成功: ${okCount}/${results.length}`);
  if (failed.length > 0) {
    logger.warn(`失败 ${failed.length} 个:`);
    for (const f of failed) {
      logger.info('  ' + chalk.red(f.project) + chalk.dim(`  ${f.reason ?? ''}`));
    }
  }
  return { results, okCount, failed };
}
