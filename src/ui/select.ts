import inquirer from 'inquirer';
import path from 'path';
import { discoverComponents } from '../core/discover';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';
import { SejuaniConfig } from '../config';
import { resolveScanTarget } from '../core/configLoader';
import { getVirtualSpaces, resolveVsComponents } from '../core/vsStore';

export interface ScanTarget {
  dir: string;
  maxDepth?: number;
  /** 若已预解析（如虚拟空间），直接使用这些组件，跳过磁盘扫描 */
  components?: Component[];
  /** 展示用标签 */
  label?: string;
}

/**
 * 让用户在「工程预设 / 组件库预设 / 虚拟空间 / 当前目录 / 手动输入」间选择一个扫描根。
 * 预设按 Sejuani 标准解析到实际的 packagesDir。
 * 选择「返回」时返回 null，由调用方回到上一级。
 */
export async function promptRoot(
  config: SejuaniConfig,
  message = '选择要扫描的范围:'
): Promise<ScanTarget | null> {
  const projects = resolveScanTarget(config.roots.projects);
  const components = resolveScanTarget(config.roots.components);
  const cwd = process.cwd();
  const spaces = getVirtualSpaces();
  const vsNames = Object.keys(spaces).sort();

  const vsChoices = vsNames.map((n) => ({
    name: `虚拟空间 ${n}  ${chalk.dim(`${spaces[n].members.length} 个组件`)}`,
    value: `vs:${n}`,
  }));

  const { choice } = await inquirer.prompt<{ choice: string }>([
    {
      type: 'list',
      name: 'choice',
      message,
      choices: [
        { name: `工程 (projects)  ${chalk.dim(projects.dir)}`, value: 'projects' },
        { name: `组件库 (components)  ${chalk.dim(components.dir)}`, value: 'components' },
        ...(vsChoices.length ? [new inquirer.Separator('─ 虚拟空间 ─') as never, ...vsChoices] : []),
        new inquirer.Separator(),
        { name: `当前目录 (cwd)  ${chalk.dim(cwd)}`, value: 'cwd' },
        { name: '手动输入目录', value: 'manual' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);

  if (choice === 'back') return null;
  if (choice === 'projects') return projects;
  if (choice === 'components') return components;
  if (choice === 'cwd') return { dir: cwd };
  if (choice.startsWith('vs:')) {
    const vsName = choice.slice(3);
    const resolved = resolveVsComponents(vsName);
    if (!resolved || resolved.components.length === 0) {
      logger.warn(`虚拟空间 ${vsName} 无可用成员。`);
      return { dir: `vs:${vsName}`, components: [], label: `虚拟空间 ${vsName}` };
    }
    if (resolved.missing.length > 0) {
      logger.warn(`虚拟空间 ${vsName} 有 ${resolved.missing.length} 个成员失效，已跳过。`);
    }
    return { dir: `vs:${vsName}`, components: resolved.components, label: `虚拟空间 ${vsName}` };
  }

  const { dir } = await inquirer.prompt<{ dir: string }>([
    {
      type: 'input',
      name: 'dir',
      message: '目录:',
      default: cwd,
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
  let all: Component[];
  if (target.components) {
    // 已预解析（如虚拟空间）：直接使用，不再扫描磁盘
    all = opts.requireYarnLock ? target.components.filter((c) => c.yarnLockPath) : target.components;
    logger.step(`${target.label ?? '已选集合'}：${all.length} 个`);
  } else {
    logger.step(`扫描 ${chalk.cyan(target.dir)} ...`);
    all = await discoverComponents(target.dir, {
      requireYarnLock: opts.requireYarnLock,
      maxDepth: target.maxDepth,
    });
  }

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
