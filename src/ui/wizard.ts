import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';
import { discoverAndSelect, promptRoot, ScanTarget } from './select';
import { discoverComponents, readSingleComponent } from '../core/discover';
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
import { buildCatalog, catalogToJson, printCatalog } from '../core/catalog';
import {
  printProjectsUsing,
  printComponentsOfProject,
  printUsageSummary,
} from '../core/usage';
import { BumpType } from '../core/version';
import { loadConfig } from '../core/configLoader';
import { resolveScanTarget } from '../core/configLoader';
import { SejuaniConfig } from '../config';
import { setActiveDomain } from '../core/domainState';
import { getRegistryOverride, setRegistry, clearRegistryOverride } from '../core/registryStore';
import { analyzeLayers, printLayers, toLayersJson, flattenLayersJson } from '../core/depsTree';
import {
  getVirtualSpaces,
  getVirtualSpace,
  saveVirtualSpace,
  removeVirtualSpace,
  resolveVsComponents,
  membersFromComponents,
  patchVirtualSpace,
  VsMember,
} from '../core/vsStore';
import { runAiFlow } from './aiFlow';
import { listTemplates } from '../core/workflow/templates';

type Action =
  | 'replace-url'
  | 'set-version'
  | 'set-name'
  | 'link'
  | 'sync'
  | 'release'
  | 'registries'
  | 'check-deps'
  | 'catalog'
  | 'who-uses'
  | 'project-deps'
  | 'usage'
  | 'upgrade'
  | 'deps-tree'
  | 'vs'
  | 'ai'
  | 'domain'
  | 'registry'
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
  if (!target) return [];
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
  await createVirtualSpace(comps, { into, force, dryRun, yes: false });
}

async function flowSync(config: SejuaniConfig): Promise<void> {
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
  });
}

async function flowRelease(config: SejuaniConfig): Promise<void> {
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
    buildSteps,
  });
}

async function flowRegistries(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  if (!target) return;
  const comps = await componentsFromTarget(target, { requireYarnLock: true });
  const { byComponent } = await inquirer.prompt<{ byComponent: boolean }>([
    { type: 'confirm', name: 'byComponent', message: '展开每个仓库涉及的组件?', default: false },
  ]);
  printRegistries(comps, byComponent);
}

async function flowCheckDeps(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  if (!target) return;
  const comps = await componentsFromTarget(target, { requireYarnLock: true });
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
  const { out } = await inquirer.prompt<{ out: string }>([
    {
      type: 'input',
      name: 'out',
      message: '导出名称+版本到 JSON 文件?（留空跳过）',
      default: '',
      filter: (v: string) => v.trim(),
    },
  ]);
  if (out) {
    fs.writeFileSync(path.resolve(out), JSON.stringify(catalogToJson(catalog), null, 2) + '\n');
    logger.success(`已导出组件清单 JSON: ${path.resolve(out)}`);
  }
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
  });
  if (!dryRun) {
    logger.warn('升级仅改写 package.json，未改动 yarn.lock；请在各工程重新执行 yarn install。');
  }
}

/** 域设置：展示当前域并切换，返回被选中的域 key */
async function flowDomain(config: SejuaniConfig): Promise<string> {
  const keys = Object.keys(config.domains);
  const { picked } = await inquirer.prompt<{ picked: string }>([
    {
      type: 'list',
      name: 'picked',
      message: `选择域（当前: ${config.activeDomain}）:`,
      default: config.activeDomain,
      choices: keys.map((k) => ({
        name: `${config.domains[k].label}  ${chalk.dim(config.domains[k].roots.projects.root)}`,
        value: k,
      })),
    },
  ]);
  setActiveDomain(picked);
  logger.success(`已切换到域 ${chalk.bold(picked)}（${config.domains[picked].label}）`);
  return picked;
}

/**
 * AI 工作流入口（向导）：可选「新建(AI 规划)」或「从模板套用」。
 * 两者均复用 runAiFlow（后者传入 template 选项，不调 AI，按当前选中组件重绑定）。
 */
async function flowAi(config: SejuaniConfig): Promise<void> {
  const templates = listTemplates();
  const { mode } = await inquirer.prompt<{ mode: 'new' | 'template' }>([
    {
      type: 'list',
      name: 'mode',
      message: 'AI 工作流:',
      choices: [
        { name: '新建（选组件 + 自然语言描述，由 AI 规划）', value: 'new' },
        {
          name: `从模板套用${templates.length ? `（${templates.length} 个可用）` : '（暂无模板）'}`,
          value: 'template',
          disabled: templates.length === 0,
        },
      ],
    },
  ]);
  if (mode === 'template') {
    const { name } = await inquirer.prompt<{ name: string }>([
      {
        type: 'list',
        name: 'name',
        message: '选择模板:',
        choices: templates.map((t) => ({ name: `${t.name}  ${chalk.dim(`${t.title} · ${t.steps.length}步`)}`, value: t.name })),
      },
    ]);
    await runAiFlow(config, { template: name });
    return;
  }
  await runAiFlow(config, {});
}

/** registry 设置：按当前域分别设置 pack / publish（持久化，供 release·sync 使用） */
async function flowRegistry(config: SejuaniConfig): Promise<void> {
  const domain = config.activeDomain;
  const base = config.domains[domain].registries;
  const showCurrent = () => {
    const ov = getRegistryOverride(domain) ?? {};
    logger.info(chalk.dim(`当前域 ${domain}：`));
    logger.info(`  pack    ${ov.pack ? chalk.green('[已设置] ') : chalk.dim('[域默认] ')}${chalk.cyan(ov.pack ?? base.pack)}`);
    logger.info(`  publish ${ov.publish ? chalk.green('[已设置] ') : chalk.dim('[域默认] ')}${chalk.cyan(ov.publish ?? base.publish)}`);
  };
  showCurrent();

  const { op } = await inquirer.prompt<{ op: 'pack' | 'publish' | 'both' | 'reset' | 'back' }>([
    {
      type: 'list',
      name: 'op',
      message: '设置项:',
      choices: [
        { name: '设置 pack（拉取源）', value: 'pack' },
        { name: '设置 publish（发布目标）', value: 'publish' },
        { name: '同时设置 pack 与 publish', value: 'both' },
        { name: '重置为域默认', value: 'reset' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);
  if (op === 'back') return;
  if (op === 'reset') {
    if (clearRegistryOverride(domain)) logger.success(`已重置域 ${chalk.bold(domain)} 的 registry 为默认`);
    else logger.warn(`域 ${domain} 未设置过 registry 覆盖`);
    return;
  }
  const ov = getRegistryOverride(domain) ?? {};
  if (op === 'pack' || op === 'both') {
    const { pack } = await inquirer.prompt<{ pack: string }>([
      { type: 'input', name: 'pack', message: 'pack registry:', default: ov.pack ?? base.pack, filter: (v: string) => v.trim() },
    ]);
    setRegistry(domain, { pack });
  }
  if (op === 'publish' || op === 'both') {
    const { publish } = await inquirer.prompt<{ publish: string }>([
      { type: 'input', name: 'publish', message: 'publish registry:', default: ov.publish ?? base.publish, filter: (v: string) => v.trim() },
    ]);
    setRegistry(domain, { publish });
  }
  logger.success(`已保存域 ${chalk.bold(domain)} 的 registry 设置。`);
  showCurrent();
}

/** 从扫描目标取全部组件：虚拟空间等已预解析集合直接返回，否则扫描磁盘。 */
async function componentsFromTarget(
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

/** 依赖分层：分析组件间依赖 → 打印 layer-0→x，可导出 JSON / 存为虚拟空间 */
async function flowDepsTree(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config, '选择要分析的组件库范围:');
  if (!target) return;
  const comps = await componentsFromTarget(target);
  if (comps.length === 0) {
    logger.warn('未发现可分析的组件。');
    return;
  }
  const root = target.components ? target.label ?? target.dir : target.dir;
  const result = analyzeLayers(comps, root);
  printLayers(result);

  const { save } = await inquirer.prompt<{ save: ('json' | 'vs')[] }>([
    {
      type: 'checkbox',
      name: 'save',
      message: '导出结果?（空格选，回车确认；不选则跳过）',
      choices: [
        { name: '导出分层 JSON 文件', value: 'json' },
        { name: '保存为虚拟空间（可用 --vs 引用）', value: 'vs' },
      ],
    },
  ]);

  if (save.includes('json')) {
    const { file } = await inquirer.prompt<{ file: string }>([
      {
        type: 'input',
        name: 'file',
        message: 'JSON 输出路径:',
        default: path.join(process.cwd(), 'layers.json'),
        filter: (v: string) => v.trim(),
      },
    ]);
    fs.writeFileSync(path.resolve(file), JSON.stringify(toLayersJson(result), null, 2) + '\n');
    logger.success(`已导出分层 JSON: ${path.resolve(file)}`);
  }

  if (save.includes('vs')) {
    const { vsName } = await inquirer.prompt<{ vsName: string }>([
      { type: 'input', name: 'vsName', message: '虚拟空间名称:', filter: (v: string) => v.trim() },
    ]);
    if (!vsName) {
      logger.warn('未输入名称，已跳过保存。');
      return;
    }
    const members: VsMember[] = [];
    const layers: string[][] = result.layers.map((l) => l.map((c) => c.name));
    for (const layer of result.layers) {
      for (const c of layer) members.push({ name: path.basename(c.dir), pkgName: c.name, dir: c.dir });
    }
    for (const c of result.cycles) members.push({ name: path.basename(c.dir), pkgName: c.name, dir: c.dir });
    saveVirtualSpace(vsName, { members, layers, source: `deps-tree:${root}` });
    logger.success(`已保存为虚拟空间 ${chalk.bold(vsName)}（${members.length} 个组件，${layers.length} 层）`);
    logger.info(chalk.dim(`使用: sjn <命令> --vs ${vsName}`));
  }
}

/** 从已有虚拟空间中挑一个（无则提示）。 */
async function pickVsName(message: string): Promise<string | null> {
  const spaces = getVirtualSpaces();
  const names = Object.keys(spaces).sort();
  if (names.length === 0) {
    logger.warn('暂无虚拟空间。可先用「依赖分层」保存，或在此新建。');
    return null;
  }
  const { picked } = await inquirer.prompt<{ picked: string }>([
    {
      type: 'list',
      name: 'picked',
      message,
      choices: names.map((n) => ({
        name: `${n}  ${chalk.dim(
          `${spaces[n].members.length} 个组件${spaces[n].layers ? ` · ${spaces[n].layers!.length} 层` : ''}`
        )}`,
        value: n,
      })),
    },
  ]);
  return picked;
}

/** 打印单个虚拟空间详情。 */
function showVsDetail(name: string): void {
  const vs = getVirtualSpace(name);
  if (!vs) {
    logger.error(`虚拟空间不存在: ${name}`);
    return;
  }
  logger.title(`虚拟空间 ${name}`);
  logger.info(chalk.dim(`来源: ${vs.source ?? '?'}   更新: ${vs.updatedAt}`));
  if (vs.linkedDir) logger.info(chalk.dim(`软链目录: ${vs.linkedDir}`));
  if (vs.layers && vs.layers.length > 0) {
    vs.layers.forEach((layer, i) => {
      logger.info(chalk.bold(`\nlayer-${i} ${chalk.dim(`(${layer.length})`)}`));
      for (const p of layer) logger.info(`  ${chalk.cyan(p)}`);
    });
  } else {
    for (const m of vs.members) logger.info(`  ${chalk.cyan(m.pkgName ?? m.name)}  ${chalk.dim(m.dir)}`);
  }
  logger.success(`\n共 ${vs.members.length} 个组件。`);
}

/** 新建虚拟空间：从组件库全量 / layers.json / 手动多选。 */
async function flowVsCreate(config: SejuaniConfig): Promise<void> {
  const { name } = await inquirer.prompt<{ name: string }>([
    { type: 'input', name: 'name', message: '新虚拟空间名称:', filter: (v: string) => v.trim() },
  ]);
  if (!name) {
    logger.warn('未输入名称，已取消。');
    return;
  }
  const { src } = await inquirer.prompt<{ src: 'catalog' | 'layers' | 'pick' }>([
    {
      type: 'list',
      name: 'src',
      message: '成员来源:',
      choices: [
        { name: '从当前域组件库全量', value: 'catalog' },
        { name: '从 deps-tree 导出的 layers.json', value: 'layers' },
        { name: '手动多选（从某范围挑选）', value: 'pick' },
      ],
    },
  ]);

  let members: VsMember[] = [];
  let layers: string[][] | undefined;
  let source = 'manual';
  if (src === 'catalog') {
    const t = resolveScanTarget(config.roots.components);
    logger.step(`扫描组件库 ${chalk.cyan(t.dir)} ...`);
    const comps = await discoverComponents(t.dir, { maxDepth: t.maxDepth });
    members = membersFromComponents(comps);
    source = `catalog:${config.activeDomain}`;
  } else if (src === 'layers') {
    const { file } = await inquirer.prompt<{ file: string }>([
      { type: 'input', name: 'file', message: 'layers.json 路径:', filter: (v: string) => v.trim() },
    ]);
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      logger.error(`文件不存在: ${abs}`);
      return;
    }
    const flat = flattenLayersJson(JSON.parse(fs.readFileSync(abs, 'utf8')));
    members = flat.members.map((m) => ({ name: path.basename(m.dir), pkgName: m.name, dir: m.dir }));
    layers = flat.layers;
    source = `layers:${abs}`;
  } else {
    const comps = await pickComponents(config);
    members = membersFromComponents(comps);
    source = 'manual';
  }
  if (members.length === 0) {
    logger.warn('没有可加入的成员，未创建。');
    return;
  }
  const vs = saveVirtualSpace(name, { members, layers, source });
  logger.success(
    `已创建虚拟空间 ${chalk.bold(name)}（${vs.members.length} 个组件${layers ? `，${layers.length} 层` : ''}）`
  );
  logger.info(chalk.dim(`使用: sjn <命令> --vs ${name}`));
}

/** 把虚拟空间物化成软链目录。 */
async function flowVsLink(): Promise<void> {
  const name = await pickVsName('选择要物化(软链)的虚拟空间:');
  if (!name) return;
  const resolved = resolveVsComponents(name);
  if (!resolved) {
    logger.error(`虚拟空间不存在: ${name}`);
    return;
  }
  if (resolved.missing.length > 0) {
    logger.warn(`有 ${resolved.missing.length} 个成员目录已失效，已跳过: ${resolved.missing.join(', ')}`);
  }
  const { into, force, dryRun } = await inquirer.prompt<{ into: string; force: boolean; dryRun: boolean }>([
    {
      type: 'input',
      name: 'into',
      message: '软链目标目录:',
      default: path.join(process.cwd(), name),
      filter: (v: string) => v.trim(),
    },
    { type: 'confirm', name: 'force', message: '覆盖已存在的同名软链?', default: false },
    { type: 'confirm', name: 'dryRun', message: '先干跑预览(不创建)?', default: true },
  ]);
  await createVirtualSpace(resolved.components, { into: path.resolve(into), force, dryRun, yes: false });
  if (!dryRun) patchVirtualSpace(name, { linkedDir: path.resolve(into) });
}

/** 虚拟空间管理：列表 / 详情 / 新建 / 物化软链 / 删除。 */
async function flowVs(config: SejuaniConfig): Promise<void> {
  const { op } = await inquirer.prompt<{ op: 'list' | 'show' | 'create' | 'link' | 'rm' | 'back' }>([
    {
      type: 'list',
      name: 'op',
      message: '虚拟空间管理:',
      choices: [
        { name: '查看列表', value: 'list' },
        { name: '查看详情', value: 'show' },
        { name: '新建虚拟空间', value: 'create' },
        { name: '物化为软链目录 (link)', value: 'link' },
        { name: '删除', value: 'rm' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);
  if (op === 'back') return;
  if (op === 'create') {
    await flowVsCreate(config);
    return;
  }
  if (op === 'link') {
    await flowVsLink();
    return;
  }
  if (op === 'list') {
    const spaces = getVirtualSpaces();
    const names = Object.keys(spaces).sort();
    logger.title('虚拟空间 (vs)');
    if (names.length === 0) {
      logger.info(chalk.dim('  (暂无) 用「依赖分层」保存，或此处新建'));
    } else {
      for (const n of names) {
        const vs = spaces[n];
        const layerNote = vs.layers ? ` · ${vs.layers.length} 层` : '';
        const linkNote = vs.linkedDir ? ` · 软链→${vs.linkedDir}` : '';
        logger.info(`  ${chalk.bold(n)}  ${chalk.dim(`${vs.members.length} 个组件${layerNote}${linkNote}`)}`);
      }
    }
    return;
  }
  if (op === 'show') {
    const name = await pickVsName('选择要查看的虚拟空间:');
    if (name) showVsDetail(name);
    return;
  }
  if (op === 'rm') {
    const name = await pickVsName('选择要删除的虚拟空间:');
    if (!name) return;
    const { ok } = await inquirer.prompt<{ ok: boolean }>([
      { type: 'confirm', name: 'ok', message: `确认删除虚拟空间 ${name}?`, default: false },
    ]);
    if (!ok) return;
    if (removeVirtualSpace(name)) logger.success(`已删除虚拟空间 ${chalk.bold(name)}`);
    else logger.warn(`虚拟空间不存在: ${name}`);
    return;
  }
}

/** 交互式向导主流程 */
export async function runWizard(configPath?: string): Promise<void> {
  let config = loadConfig(configPath);
  logger.title('Sejuani · 前端工程/组件批量与依赖治理工具');
  logger.info(
    chalk.dim(`当前域: ${chalk.cyan(config.activeDomain)}（${config.domains[config.activeDomain]?.label ?? '?'}）  可在菜单「域设置」切换`)
  );

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
          { name: `替换 resolved URL  ${chalk.dim('replace-url · yarn.lock')}`, value: 'replace-url' },
          { name: `修改版本号  ${chalk.dim('set-version · package.json')}`, value: 'set-version' },
          { name: `修改包名  ${chalk.dim('set-name · package.json')}`, value: 'set-name' },
          { name: `创建虚拟空间  ${chalk.dim('link · 软链聚合')}`, value: 'link' },
          { name: `仓库发布同步  ${chalk.dim('sync · pack→publish')}`, value: 'sync' },
          { name: `完整发包  ${chalk.dim('release · build→pack→publish')}`, value: 'release' },
          new inquirer.Separator('— 依赖治理 / 查询 —'),
          { name: `枚举仓库源  ${chalk.dim('registries · yarn.lock')}`, value: 'registries' },
          { name: `校验依赖可达性  ${chalk.dim('check-deps')}`, value: 'check-deps' },
          { name: `组件库清单  ${chalk.dim('catalog · 名称+版本')}`, value: 'catalog' },
          { name: `组件反查工程  ${chalk.dim('who-uses')}`, value: 'who-uses' },
          { name: `工程依赖清单  ${chalk.dim('project-deps')}`, value: 'project-deps' },
          { name: `组件用量统计  ${chalk.dim('usage')}`, value: 'usage' },
          { name: `升级组件版本  ${chalk.dim('upgrade · 按 catalog')}`, value: 'upgrade' },
          { name: `依赖分层  ${chalk.dim('deps-tree · layer-0→x / 导出 JSON')}`, value: 'deps-tree' },
          new inquirer.Separator('— 环境 —'),
          { name: `AI 工作流  ${chalk.dim('ai · 自然语言→可审阅编排执行')}`, value: 'ai' },
          { name: `虚拟空间管理  ${chalk.dim('vs · 创建/列表/物化软链')}`, value: 'vs' },
          { name: `registry 设置  ${chalk.dim('registry · pack/publish 按域持久化')}`, value: 'registry' },
          { name: `域设置 / 切换  ${chalk.dim('domain · chery/foton/saas')}`, value: 'domain' },
          new inquirer.Separator(),
          { name: '退出', value: 'quit' },
        ],
      },
    ]);

    if (action === 'quit') break;
    try {
      if (action === 'domain') {
        await flowDomain(config);
        config = loadConfig(configPath); // 重载以应用新域的 roots/registries
      } else if (action === 'replace-url') await flowReplaceUrl(config);
      else if (action === 'set-version') await flowSetVersion(config);
      else if (action === 'set-name') await flowSetName(config);
      else if (action === 'link') await flowLink(config);
      else if (action === 'sync') await flowSync(config);
      else if (action === 'release') await flowRelease(config);
      else if (action === 'registries') await flowRegistries(config);
      else if (action === 'check-deps') await flowCheckDeps(config);
      else if (action === 'catalog') await flowCatalog(config);
      else if (action === 'who-uses') await flowWhoUses(config);
      else if (action === 'project-deps') await flowProjectDeps(config);
      else if (action === 'usage') await flowUsage(config);
      else if (action === 'upgrade') await flowUpgrade(config);
      else if (action === 'deps-tree') await flowDepsTree(config);
      else if (action === 'vs') await flowVs(config);
      else if (action === 'ai') await flowAi(config);
      else if (action === 'registry') {
        await flowRegistry(config);
        config = loadConfig(configPath); // 重载以应用新的 registry 覆盖
      }
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
