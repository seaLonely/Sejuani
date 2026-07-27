import inquirer from 'inquirer';
import path from 'path';
import { Component } from '../../core/types';
import { chalk, logger } from '../../utils/logger';
import { SejuaniConfig } from '../../core/config';
import { promptRoot, discoverAndSelect } from '../select';
import { readSingleComponent, discoverComponents } from '../../core/discover';
import {
  buildNameChanges,
  buildReplaceUrlChanges,
  buildUpgradeChanges,
  buildVersionChanges,
} from '../../core/operations';
import { runChanges } from '../../core/runner';
import { createVirtualSpace } from '../../core/link';
import { syncComponents } from '../../core/repoSync';
import { buildCatalog } from '../../core/catalog';
import { BumpType } from '../../core/version';
import { resolveScanTarget } from '../../core/config';
import { askDryAndBackup, pickComponents } from './common';
import { inquirerConfirm } from '../prompt';

export async function flowReplaceUrl(config: SejuaniConfig): Promise<void> {
  const comps = (await pickComponents(config, true)).filter((c) => c.yarnLockPath);
  if (comps.length === 0) return;
  const { from, to } = await inquirer.prompt<{ from: string; to: string }>([
    { type: 'input', name: 'from', message: '要替换的 URL 片段(from):', default: config.registries.pack },
    { type: 'input', name: 'to', message: '替换为(to):', default: 'http://nexus-ditc.mychery.com/repository/npm' },
  ]);
  const { dryRun, backup } = await askDryAndBackup();
  await runChanges(buildReplaceUrlChanges(comps, from.trim(), to.trim()), {
    dryRun,
    backup,
    yes: false,
    showDiff: true,
    confirm: inquirerConfirm,
  });
}

export async function flowSetVersion(config: SejuaniConfig): Promise<void> {
  const comps = await pickComponents(config);
  if (comps.length === 0) return;
  const { mode } = await inquirer.prompt<{ mode: 'bump' | 'set' }>([
    {
      type: 'list',
      name: 'mode',
      message: '版本修改方式:',
      choices: [
        { name: '递增 bump（patch/minor/major，保留 -后缀）', value: 'bump' },
        { name: '设为指定版本 set', value: 'set' },
      ],
    },
  ]);

  let changes;
  if (mode === 'bump') {
    const { bump } = await inquirer.prompt<{ bump: BumpType }>([
      { type: 'list', name: 'bump', message: '递增级别:', choices: ['patch', 'minor', 'major'], default: 'patch' },
    ]);
    changes = buildVersionChanges(comps, { mode: 'bump', bump });
  } else {
    const { target, keepSuffix } = await inquirer.prompt<{ target: string; keepSuffix: boolean }>([
      { type: 'input', name: 'target', message: '目标版本(如 1.2.0 或 1.2.0-chery):' },
      { type: 'confirm', name: 'keepSuffix', message: '若未写后缀，沿用各组件当前后缀?', default: true },
    ]);
    changes = buildVersionChanges(comps, { mode: 'set', target: target.trim(), keepSuffix });
  }
  const { dryRun, backup } = await askDryAndBackup();
  await runChanges(changes, { dryRun, backup, yes: false, showDiff: true, confirm: inquirerConfirm });
}

export async function flowSetName(config: SejuaniConfig): Promise<void> {
  const comps = await pickComponents(config);
  if (comps.length === 0) return;
  const { mode } = await inquirer.prompt<{ mode: 'set' | 'replace' }>([
    {
      type: 'list',
      name: 'mode',
      message: 'name 修改方式:',
      choices: [
        { name: '查找替换（在原 name 中替换子串）', value: 'replace' },
        { name: '整体设为固定值（不推荐批量）', value: 'set' },
      ],
    },
  ]);
  let changes;
  if (mode === 'replace') {
    const { find, replace } = await inquirer.prompt<{ find: string; replace: string }>([
      { type: 'input', name: 'find', message: '查找(find):' },
      { type: 'input', name: 'replace', message: '替换为(replace):', default: '' },
    ]);
    changes = buildNameChanges(comps, { find: find.trim(), replace });
  } else {
    const { target } = await inquirer.prompt<{ target: string }>([
      { type: 'input', name: 'target', message: '新的 name:' },
    ]);
    changes = buildNameChanges(comps, { target: target.trim() });
  }
  const { dryRun, backup } = await askDryAndBackup();
  await runChanges(changes, { dryRun, backup, yes: false, showDiff: true, confirm: inquirerConfirm });
}

export async function flowLink(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  if (!target) return;
  const comps = await discoverAndSelect(target);
  if (comps.length === 0) return;
  const { into, force, dryRun } = await inquirer.prompt<{ into: string; force: boolean; dryRun: boolean }>([
    {
      type: 'input',
      name: 'into',
      message: '虚拟空间目录(将在其中创建软链):',
      default: path.join(target.dir, '.sejuani-space'),
      filter: (v: string) => v.trim(),
    },
    { type: 'confirm', name: 'force', message: '若已存在同名软链则覆盖?', default: false },
    { type: 'confirm', name: 'dryRun', message: '先干跑预览(不创建)?', default: true },
  ]);
  await createVirtualSpace(comps, { into, force, dryRun, yes: false, confirm: inquirerConfirm });
}

export async function flowSync(config: SejuaniConfig): Promise<void> {
  // 仓同步仅针对组件库（pack→publish 组件），不涉及工程。
  const t = resolveScanTarget(config.roots.components);
  const comps = await discoverAndSelect(t);
  if (comps.length === 0) return;
  const { packRegistry, publishRegistry, dryRun } = await inquirer.prompt<{
    packRegistry: string;
    publishRegistry: string;
    dryRun: boolean;
  }>([
    { type: 'input', name: 'packRegistry', message: 'pack 源 registry:', default: config.registries.pack },
    { type: 'input', name: 'publishRegistry', message: 'publish 目标 registry:', default: config.registries.publish },
    { type: 'confirm', name: 'dryRun', message: '先干跑预览(不实际执行)?', default: true },
  ]);
  await syncComponents(comps, {
    packRegistry: packRegistry.trim(),
    publishRegistry: publishRegistry.trim(),
    dryRun,
    yes: false,
    confirm: inquirerConfirm,
  });
}

export async function flowRelease(config: SejuaniConfig): Promise<void> {
  // 选择发包范围：当前目录（单个组件）或从组件库多选（批量）
  const { scope } = await inquirer.prompt<{ scope: 'cwd' | 'pick' | 'back' }>([
    {
      type: 'list',
      name: 'scope',
      message: '发包范围:',
      choices: [
        { name: `当前目录（单个组件）  ${chalk.dim(process.cwd())}`, value: 'cwd' },
        { name: '从组件库选择（可多选批量）', value: 'pick' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);
  if (scope === 'back') return;

  let comps: Component[];
  if (scope === 'cwd') {
    const one = readSingleComponent(process.cwd());
    if (!one) {
      logger.error(`当前目录未找到 package.json: ${process.cwd()}`);
      return;
    }
    comps = [one];
  } else {
    const t = resolveScanTarget(config.roots.components);
    comps = await discoverAndSelect(t);
    if (comps.length === 0) return;
  }

  // 发布模式：完整（build+pack+publish）或仅同步（pack+publish）
  const { mode } = await inquirer.prompt<{ mode: 'full' | 'mirror' }>([
    {
      type: 'list',
      name: 'mode',
      message: '发布模式:',
      choices: [
        { name: `完整发包  ${chalk.dim((config.buildSteps ?? []).join(' → ') + ' → pack → publish')}`, value: 'full' },
        { name: `仅同步  ${chalk.dim('pack → publish')}`, value: 'mirror' },
      ],
    },
  ]);
  const buildSteps = mode === 'full' ? config.buildSteps ?? [] : [];

  const { packRegistry, publishRegistry, dryRun } = await inquirer.prompt<{
    packRegistry: string;
    publishRegistry: string;
    dryRun: boolean;
  }>([
    { type: 'input', name: 'packRegistry', message: 'pack 源 registry:', default: config.registries.pack },
    { type: 'input', name: 'publishRegistry', message: 'publish 目标 registry:', default: config.registries.publish },
    { type: 'confirm', name: 'dryRun', message: '先干跑预览（不实际执行）?', default: true },
  ]);
  await syncComponents(comps, {
    packRegistry: packRegistry.trim(),
    publishRegistry: publishRegistry.trim(),
    dryRun,
    yes: false,
    confirm: inquirerConfirm,
    buildSteps,
  });
}

export async function flowUpgrade(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  logger.step('扫描工程与组件库 ...');
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  logger.info(chalk.dim(`工程 ${projects.length} 个，catalog ${catalog.size} 个组件。`));

  const { mode } = await inquirer.prompt<{ mode: 'all' | 'pick' | 'back' }>([
    {
      type: 'list',
      name: 'mode',
      message: '升级方式:',
      choices: [
        { name: '全量升级（工程内所有组件依赖 → catalog 精确版）', value: 'all' },
        { name: '指定组件升级（选择一个或多个）', value: 'pick' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);
  if (mode === 'back') return;

  let only: string[] | undefined;
  if (mode === 'pick') {
    const items = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (items.length === 0) {
      logger.warn('组件库为空，无可选组件。');
      return;
    }
    const { picked } = await inquirer.prompt<{ picked: string[] }>([
      {
        type: 'checkbox',
        name: 'picked',
        message: '选择要升级的组件（空格选/取消，回车确认）:',
        pageSize: 20,
        loop: false,
        choices: items.map((i) => ({ name: `${i.name}  ${chalk.dim(i.version || '?')}`, value: i.name })),
      },
    ]);
    if (picked.length === 0) {
      logger.warn('未选择任何组件，已取消。');
      return;
    }
    only = picked;
  }

  const { dryRun, backup } = await askDryAndBackup();
  await runChanges(buildUpgradeChanges(projects, catalog, { only }), {
    dryRun,
    backup,
    yes: false,
    showDiff: true,
    confirm: inquirerConfirm,
  });
  if (!dryRun) {
    logger.warn('升级仅改写 package.json，未改动 yarn.lock；请在各工程重新执行 yarn install。');
  }
}
