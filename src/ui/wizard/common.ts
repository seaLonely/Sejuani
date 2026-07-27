import inquirer from 'inquirer';
import { Component } from '../../core/types';
import { chalk, logger } from '../../utils/logger';
import { SejuaniConfig } from '../../core/config';
import { promptRoot, discoverAndSelect, ScanTarget } from '../select';
import { discoverComponents } from '../../core/discover';

/** 询问干跑与备份选项（写操作通用）。 */
export async function askDryAndBackup(): Promise<{ dryRun: boolean; backup: boolean }> {
  const { dryRun, backup } = await inquirer.prompt<{ dryRun: boolean; backup: boolean }>([
    { type: 'confirm', name: 'dryRun', message: '先干跑预览（不写入）?', default: true },
    {
      type: 'confirm',
      name: 'backup',
      message: '写入前生成 .bak 备份?',
      default: true,
      when: (ans) => ans.dryRun === false,
    },
  ]);
  return { dryRun, backup: backup ?? true };
}

/** 选择一个根并多选其中的组件/工程 */
export async function pickComponents(
  config: SejuaniConfig,
  requireYarnLock = false
): Promise<Component[]> {
  const target = await promptRoot(config);
  if (!target) return [];
  return discoverAndSelect(target, { requireYarnLock });
}

/** 从扫描目标取全部组件：虚拟空间等已预解析集合直接返回，否则扫描磁盘。 */
export async function componentsFromTarget(
  target: ScanTarget,
  opts: { requireYarnLock?: boolean } = {}
): Promise<Component[]> {
  if (target.components) {
    const all = opts.requireYarnLock
      ? target.components.filter((c) => c.yarnLockPath)
      : target.components;
    logger.step(`${target.label ?? '已选集合'}：${all.length} 个`);
    return all;
  }
  logger.step(`扫描 ${chalk.cyan(target.dir)} ...`);
  return discoverComponents(target.dir, {
    requireYarnLock: opts.requireYarnLock,
    maxDepth: target.maxDepth,
  });
}
