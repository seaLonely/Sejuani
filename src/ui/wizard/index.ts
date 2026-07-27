import inquirer from 'inquirer';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/config';
import { SejuaniConfig } from '../../core/config';
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
import { flowYunxiao, flowFix, flowYunxiaoSettings, flowTaskBoard } from './yunxiao';
import { flowDomain } from './domain';
import { flowRegistry } from './registry';
import { flowVs } from './vs';

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
  | 'yunxiao-settings'
  | 'task-board'
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
    hint: '任务看板 · AI 工作流 · 自动修复',
    actions: [
      { name: `任务看板  ${chalk.dim('当前迭代工单 + 操作')}`, value: 'task-board' },
      { name: `AI 工作流  ${chalk.dim('ai · 自然语言→可审阅编排执行')}`, value: 'ai' },
      { name: `AI 修复 bug  ${chalk.dim('fix · 本地 AI 修复→MR→评论/状态')}`, value: 'fix' },
      { name: `云效默认设置  ${chalk.dim('默认迭代/团队/负责人')}`, value: 'yunxiao-settings' },
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
    case 'task-board': await flowTaskBoard(); break;
    case 'yunxiao-settings': await flowYunxiaoSettings(); break;
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

/**
 * 交互式向导主流程：两级分类菜单（分类 → 操作），不循环滚动。
 *
 * @param entry 起始入口：某个分类 key（如 'batch'/'ai'）则直接进入该分类，减少首屏选择；
 *              'all' 则先展示全部分类。无论从哪里进入，「返回上级」后均回到分类选择。
 */
export async function runWizard(configPath?: string, entry: string = 'batch'): Promise<void> {
  let config = loadConfig(configPath);
  logger.title('Sejuani · 前端工程/组件批量与依赖治理工具');
  logger.info(
    chalk.dim(`当前域: ${chalk.cyan(config.activeDomain)}（${config.domains[config.activeDomain]?.label ?? '?'}）  可在「环境 / 设置 → 域设置」切换`)
  );

  const QUIT = '__quit__';
  const BACK = '__back__';

  // 起始直进分类：entry 命中某分类则跳过首屏选择；'all' 或返回后置空，下一轮展示分类选择。
  // 'task' 特殊入口：直接进入任务看板，不进分类菜单。
  let pending: string | null = entry === 'all' ? null : entry;

  // 顶层：选择功能分类
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // 特殊入口 'task' 直达看板
    if (pending === 'task') {
      pending = null;
      await flowTaskBoard();
      continue; // 看板退出后回到分类选择
    }

    let cat: string;
    if (pending) {
      cat = pending;
      pending = null;
    } else {
      const ans = await inquirer.prompt<{ cat: string }>([
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
      cat = ans.cat;
    }
    if (cat === QUIT) break;
    const category = MENU.find((c) => c.key === cat);
    if (!category) continue; // 无效 entry → 下一轮回到分类选择

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
