import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { chalk, logger } from '../../utils/logger';
import { discoverComponents } from '../../core/discover';
import { createVirtualSpace } from '../../core/link';
import { loadConfig, resolveScanTarget } from '../../core/configLoader';
import { SejuaniConfig } from '../../config';
import { setActiveDomain } from '../../core/domainState';
import { getRegistryOverride, setRegistry, clearRegistryOverride } from '../../core/registryStore';
import { flattenLayersJson } from '../../core/depsTree';
import {
  getVirtualSpaces,
  getVirtualSpace,
  saveVirtualSpace,
  removeVirtualSpace,
  resolveVsComponents,
  membersFromComponents,
  patchVirtualSpace,
  VsMember,
} from '../../core/vsStore';
import { pickComponents } from './common';
import {
  flowReplaceUrl,
  flowSetVersion,
  flowSetName,
  flowLink,
  flowSync,
  flowRelease,
  flowUpgrade,
} from './batch';
import { flowCatalog, flowWhoUses, flowProjectDeps, flowUsage } from './query';
import { flowRegistries, flowCheckDeps, flowDepsTree } from './deps';
import { flowAi } from './ai';
import { flowYunxiao, flowFix } from './yunxiao';

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
  | 'yunxiao'
  | 'fix'
  | 'domain'
  | 'registry';

/** 单个可执行操作（子菜单项）。 */
interface MenuAction {
  name: string;
  value: Action;
}

/** 功能分类（顶层菜单项 → 一组操作）。 */
interface MenuCategory {
  key: string;
  label: string;
  hint: string;
  actions: MenuAction[];
}

/**
 * 菜单按功能域分类：顶层只列分类，进入后再选具体操作。
 * 每层选项都控制在一屏内，配合 loop:false 关闭回绕式循环滚动。
 */
const MENU: MenuCategory[] = [
  {
    key: 'batch',
    label: '批量编辑',
    hint: 'package.json / yarn.lock 改写与发布',
    actions: [
      { name: `替换 resolved URL  ${chalk.dim('replace-url · yarn.lock')}`, value: 'replace-url' },
      { name: `修改版本号  ${chalk.dim('set-version · package.json')}`, value: 'set-version' },
      { name: `修改包名  ${chalk.dim('set-name · package.json')}`, value: 'set-name' },
      { name: `创建虚拟空间  ${chalk.dim('link · 软链聚合')}`, value: 'link' },
      { name: `仓库发布同步  ${chalk.dim('sync · pack→publish')}`, value: 'sync' },
      { name: `完整发包  ${chalk.dim('release · build→pack→publish')}`, value: 'release' },
    ],
  },
  {
    key: 'deps',
    label: '依赖治理 / 查询',
    hint: '组件清单 / 反查 / 用量 / 分层',
    actions: [
      { name: `枚举仓库源  ${chalk.dim('registries · yarn.lock')}`, value: 'registries' },
      { name: `校验依赖可达性  ${chalk.dim('check-deps')}`, value: 'check-deps' },
      { name: `组件库清单  ${chalk.dim('catalog · 名称+版本')}`, value: 'catalog' },
      { name: `组件反查工程  ${chalk.dim('who-uses')}`, value: 'who-uses' },
      { name: `工程依赖清单  ${chalk.dim('project-deps')}`, value: 'project-deps' },
      { name: `组件用量统计  ${chalk.dim('usage')}`, value: 'usage' },
      { name: `升级组件版本  ${chalk.dim('upgrade · 按 catalog')}`, value: 'upgrade' },
      { name: `依赖分层  ${chalk.dim('deps-tree · layer-0→x / 导出 JSON')}`, value: 'deps-tree' },
    ],
  },
  {
    key: 'ai',
    label: 'AI / 云效协作',
    hint: 'AI 工作流 · 云效工单 · 自动修复',
    actions: [
      { name: `AI 工作流  ${chalk.dim('ai · 自然语言→可审阅编排执行')}`, value: 'ai' },
      { name: `云效工单管理  ${chalk.dim('issue · 查看/搜索工作项')}`, value: 'yunxiao' },
      { name: `AI 修复 bug  ${chalk.dim('fix · 本地 AI 修复→MR→评论/状态')}`, value: 'fix' },
    ],
  },
  {
    key: 'env',
    label: '环境 / 设置',
    hint: '虚拟空间 · registry · 域切换',
    actions: [
      { name: `虚拟空间管理  ${chalk.dim('vs · 创建/列表/物化软链')}`, value: 'vs' },
      { name: `registry 设置  ${chalk.dim('registry · pack/publish 按域持久化')}`, value: 'registry' },
      { name: `域设置 / 切换  ${chalk.dim('domain · chery/foton/saas')}`, value: 'domain' },
    ],
  },
];

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

/** 执行单个操作，返回（可能因域/registry 变更而重载后的）配置。 */
async function runAction(action: Action, config: SejuaniConfig, configPath?: string): Promise<SejuaniConfig> {
  switch (action) {
    case 'replace-url': await flowReplaceUrl(config); break;
    case 'set-version': await flowSetVersion(config); break;
    case 'set-name': await flowSetName(config); break;
    case 'link': await flowLink(config); break;
    case 'sync': await flowSync(config); break;
    case 'release': await flowRelease(config); break;
    case 'registries': await flowRegistries(config); break;
    case 'check-deps': await flowCheckDeps(config); break;
    case 'catalog': await flowCatalog(config); break;
    case 'who-uses': await flowWhoUses(config); break;
    case 'project-deps': await flowProjectDeps(config); break;
    case 'usage': await flowUsage(config); break;
    case 'upgrade': await flowUpgrade(config); break;
    case 'deps-tree': await flowDepsTree(config); break;
    case 'vs': await flowVs(config); break;
    case 'ai': await flowAi(config); break;
    case 'yunxiao': await flowYunxiao(); break;
    case 'fix': await flowFix(); break;
    case 'domain':
      await flowDomain(config);
      return loadConfig(configPath); // 重载以应用新域的 roots/registries
    case 'registry':
      await flowRegistry(config);
      return loadConfig(configPath); // 重载以应用新的 registry 覆盖
  }
  return config;
}

/** 交互式向导主流程：两级分类菜单（分类 → 操作），不循环滚动。 */
export async function runWizard(configPath?: string): Promise<void> {
  let config = loadConfig(configPath);
  logger.title('Sejuani · 前端工程/组件批量与依赖治理工具');
  logger.info(
    chalk.dim(`当前域: ${chalk.cyan(config.activeDomain)}（${config.domains[config.activeDomain]?.label ?? '?'}）  可在「环境 / 设置 → 域设置」切换`)
  );

  const QUIT = '__quit__';
  const BACK = '__back__';

  // 顶层：选择功能分类
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { cat } = await inquirer.prompt<{ cat: string }>([
      {
        type: 'list',
        name: 'cat',
        message: '选择功能分类:',
        loop: false,
        pageSize: MENU.length + 3,
        choices: [
          ...MENU.map((c) => ({ name: `${c.label}  ${chalk.dim('· ' + c.hint)}`, value: c.key })),
          new inquirer.Separator(),
          { name: '退出', value: QUIT },
        ],
      },
    ]);
    if (cat === QUIT) break;
    const category = MENU.find((c) => c.key === cat);
    if (!category) continue;

    // 次级：在该分类内选择操作，直到「返回上级」
    let back = false;
    while (!back) {
      const { action } = await inquirer.prompt<{ action: string }>([
        {
          type: 'list',
          name: 'action',
          message: `${category.label}:`,
          loop: false,
          pageSize: category.actions.length + 3,
          choices: [
            ...category.actions,
            new inquirer.Separator(),
            { name: chalk.dim('↩ 返回上级'), value: BACK },
          ],
        },
      ]);
      if (action === BACK) break;
      try {
        config = await runAction(action as Action, config, configPath);
      } catch (err) {
        logger.error((err as Error).message);
      }
      const { again } = await inquirer.prompt<{ again: boolean }>([
        { type: 'confirm', name: 'again', message: `继续「${category.label}」的其它操作?`, default: true },
      ]);
      back = !again;
    }
  }

  logger.info(chalk.dim('\n再见 👋'));
}
