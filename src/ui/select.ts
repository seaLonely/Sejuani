import inquirer from 'inquirer';
import path from 'path';
import { discoverComponents } from '../core/discover';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';
import { SejuaniConfig } from '../config';
import { resolveScanTarget } from '../core/configLoader';

export interface ScanTarget {
  dir: string;
  maxDepth?: number;
}

/**
 * 让用户在「工程预设 / 组件库预设 / 手动输入」间选择一个扫描根。
 * 预设按 Sejuani 标准解析到实际的 packagesDir。
 */
export async function promptRoot(
  config: SejuaniConfig,
  message = '选择要扫描的范围:'
): Promise<ScanTarget> {
  const projects = resolveScanTarget(config.roots.projects);
  const components = resolveScanTarget(config.roots.components);

  const { choice } = await inquirer.prompt<{ choice: string }>([
    {
      type: 'list',
      name: 'choice',
      message,
      choices: [
        { name: `工程 (projects)  ${chalk.dim(projects.dir)}`, value: 'projects' },
        { name: `组件库 (components)  ${chalk.dim(components.dir)}`, value: 'components' },
        { name: '手动输入目录', value: 'manual' },
      ],
    },
  ]);

  if (choice === 'projects') return projects;
  if (choice === 'components') return components;

  const { dir } = await inquirer.prompt<{ dir: string }>([
    {
      type: 'input',
      name: 'dir',
      message: '目录:',
      default: process.cwd(),
      filter: (v: string) => v.trim(),
    },
  ]);
  return { dir: path.resolve(dir) };
}

/**
 * 发现组件并让用户多选。
 */
export async function discoverAndSelect(
  target: ScanTarget,
  opts: { requireYarnLock?: boolean } = {}
): Promise<Component[]> {
  logger.step(`扫描 ${chalk.cyan(target.dir)} ...`);
  const all = await discoverComponents(target.dir, {
    requireYarnLock: opts.requireYarnLock,
    maxDepth: target.maxDepth,
  });

  if (all.length === 0) {
    logger.warn(
      opts.requireYarnLock
        ? '未发现包含 yarn.lock 的组件。'
        : '未发现包含 package.json 的组件/工程。'
    );
    return [];
  }

  logger.success(`发现 ${all.length} 个。`);

  const { selected } = await inquirer.prompt<{ selected: Component[] }>([
    {
      type: 'checkbox',
      name: 'selected',
      message: '选择要操作的项（空格选/取消，回车确认，默认全选）:',
      pageSize: 20,
      loop: false,
      choices: all.map((c) => ({
        name: `${c.name}  ${chalk.dim(
          `${c.pkgName ?? '?'}@${c.pkgVersion ?? '?'}${c.yarnLockPath ? '' : '  (无 yarn.lock)'}`
        )}`,
        value: c,
        checked: true,
      })),
    },
  ]);

  return selected;
}
