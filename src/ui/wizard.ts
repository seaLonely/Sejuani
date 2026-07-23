import inquirer from 'inquirer';
import path from 'path';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';
import { discoverAndSelect, promptRoot, ScanTarget } from './select';
import { discoverComponents } from '../core/discover';
import {
  buildNameChanges,
  buildReplaceUrlChanges,
  buildUpgradeChanges,
  buildVersionChanges,
} from '../core/operations';
import { runChanges } from '../core/runner';
import { createVirtualSpace } from '../core/link';
import { syncComponents } from '../core/repoSync';
import { printRegistries } from '../core/registries';
import { checkDependencies } from '../core/depCheck';
import { buildCatalog, printCatalog } from '../core/catalog';
import {
  printProjectsUsing,
  printComponentsOfProject,
  printUsageSummary,
} from '../core/usage';
import { BumpType } from '../core/version';
import { loadConfig } from '../core/configLoader';
import { resolveScanTarget } from '../core/configLoader';
import { SejuaniConfig } from '../config';

type Action =
  | 'replace-url'
  | 'set-version'
  | 'set-name'
  | 'link'
  | 'sync'
  | 'registries'
  | 'check-deps'
  | 'catalog'
  | 'who-uses'
  | 'project-deps'
  | 'usage'
  | 'upgrade'
  | 'quit';

async function askDryAndBackup(): Promise<{ dryRun: boolean; backup: boolean }> {
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
async function pickComponents(
  config: SejuaniConfig,
  requireYarnLock = false
): Promise<Component[]> {
  const target = await promptRoot(config);
  return discoverAndSelect(target, { requireYarnLock });
}

async function flowReplaceUrl(config: SejuaniConfig): Promise<void> {
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
  });
}

async function flowSetVersion(config: SejuaniConfig): Promise<void> {
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
  await runChanges(changes, { dryRun, backup, yes: false, showDiff: true });
}

async function flowSetName(config: SejuaniConfig): Promise<void> {
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
  await runChanges(changes, { dryRun, backup, yes: false, showDiff: true });
}

async function flowLink(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
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
  await createVirtualSpace(comps, { into, force, dryRun, yes: false });
}

async function flowSync(config: SejuaniConfig): Promise<void> {
  const comps = await pickComponents(config);
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
  });
}

async function flowRegistries(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  const comps = await discoverComponents(target.dir, { requireYarnLock: true, maxDepth: target.maxDepth });
  const { byComponent } = await inquirer.prompt<{ byComponent: boolean }>([
    { type: 'confirm', name: 'byComponent', message: '展开每个仓库涉及的组件?', default: false },
  ]);
  printRegistries(comps, byComponent);
}

async function flowCheckDeps(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  const comps = await discoverComponents(target.dir, { requireYarnLock: true, maxDepth: target.maxDepth });
  const { concurrency, timeout, onlyMissing } = await inquirer.prompt<{
    concurrency: number;
    timeout: number;
    onlyMissing: boolean;
  }>([
    { type: 'number', name: 'concurrency', message: '并发数:', default: 12 },
    { type: 'number', name: 'timeout', message: '单请求超时(ms):', default: 8000 },
    { type: 'confirm', name: 'onlyMissing', message: '只显示异常项?', default: true },
  ]);
  await checkDependencies(comps, { concurrency, timeout, onlyMissing });
}

async function flowCatalog(config: SejuaniConfig): Promise<void> {
  const t = resolveScanTarget(config.roots.components);
  logger.step(`扫描组件库 ${chalk.cyan(t.dir)} ...`);
  const catalog = await buildCatalog(t.dir, t.maxDepth);
  printCatalog(catalog, false);
}

async function flowWhoUses(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  const { name } = await inquirer.prompt<{ name: string }>([
    { type: 'input', name: 'name', message: '组件包名(如 @f6p/xxx):', filter: (v: string) => v.trim() },
  ]);
  printProjectsUsing(name, projects, catalog);
}

async function flowProjectDeps(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  const { name } = await inquirer.prompt<{ name: string }>([
    { type: 'input', name: 'name', message: '工程名(目录名或 package name):', filter: (v: string) => v.trim() },
  ]);
  printComponentsOfProject(name, projects, catalog);
}

async function flowUsage(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  printUsageSummary(projects, catalog, false);
}

async function flowUpgrade(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  logger.step('扫描工程与组件库 ...');
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  logger.info(chalk.dim(`工程 ${projects.length} 个，catalog ${catalog.size} 个组件。`));
  const { dryRun, backup } = await askDryAndBackup();
  await runChanges(buildUpgradeChanges(projects, catalog), {
    dryRun,
    backup,
    yes: false,
    showDiff: true,
  });
}

/** 交互式向导主流程 */
export async function runWizard(configPath?: string): Promise<void> {
  logger.title('Sejuani · 前端工程/组件批量与依赖治理工具');
  const config = loadConfig(configPath);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { action } = await inquirer.prompt<{ action: Action }>([
      {
        type: 'list',
        name: 'action',
        message: '选择操作:',
        pageSize: 20,
        choices: [
          new inquirer.Separator('— 批量编辑 —'),
          { name: '替换 yarn.lock 中的 resolved URL', value: 'replace-url' },
          { name: '修改 package.json 的 version', value: 'set-version' },
          { name: '修改 package.json 的 name', value: 'set-name' },
          { name: '创建虚拟空间（软链聚合）', value: 'link' },
          { name: '仓同步（pack→publish→清理 tgz）', value: 'sync' },
          new inquirer.Separator('— 依赖治理/查询 —'),
          { name: '枚举 yarn.lock 中的仓库', value: 'registries' },
          { name: '校验依赖是否存在（curl）', value: 'check-deps' },
          { name: '组件库清单（名称+版本）', value: 'catalog' },
          { name: '组件被哪些工程使用', value: 'who-uses' },
          { name: '工程用了哪些组件', value: 'project-deps' },
          { name: '全工程组件用量统计', value: 'usage' },
          { name: '升级工程内组件版本（按 catalog 精确版）', value: 'upgrade' },
          new inquirer.Separator(),
          { name: '退出', value: 'quit' },
        ],
      },
    ]);

    if (action === 'quit') break;
    try {
      if (action === 'replace-url') await flowReplaceUrl(config);
      else if (action === 'set-version') await flowSetVersion(config);
      else if (action === 'set-name') await flowSetName(config);
      else if (action === 'link') await flowLink(config);
      else if (action === 'sync') await flowSync(config);
      else if (action === 'registries') await flowRegistries(config);
      else if (action === 'check-deps') await flowCheckDeps(config);
      else if (action === 'catalog') await flowCatalog(config);
      else if (action === 'who-uses') await flowWhoUses(config);
      else if (action === 'project-deps') await flowProjectDeps(config);
      else if (action === 'usage') await flowUsage(config);
      else if (action === 'upgrade') await flowUpgrade(config);
    } catch (err) {
      logger.error((err as Error).message);
    }

    const { again } = await inquirer.prompt<{ again: boolean }>([
      { type: 'confirm', name: 'again', message: '继续其它操作?', default: true },
    ]);
    if (!again) break;
  }

  logger.info(chalk.dim('\n再见 👋'));
}
