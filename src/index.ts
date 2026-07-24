#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { discoverComponents, readSingleComponent } from './core/discover';
import { Component } from './types';
import {
  buildNameChanges,
  buildReplaceUrlChanges,
  buildUpgradeChanges,
  buildVersionChanges,
} from './core/operations';
import { runChanges } from './core/runner';
import { createVirtualSpace } from './core/link';
import { runWizard } from './ui/wizard';
import { BumpType } from './core/version';
import { chalk, logger } from './utils/logger';
import { loadConfig, resolveScanTarget } from './core/configLoader';
import { SejuaniConfig } from './config';
import { setActiveDomain } from './core/domainState';
import {
  getRegistryOverride,
  getAllRegistryOverrides,
  setRegistry,
  clearRegistryOverride,
  registryStateFilePath,
} from './core/registryStore';
import {
  getAliases,
  setAlias,
  removeAlias,
  expandAlias,
  aliasStateFilePath,
} from './core/aliasStore';
import { ScanTarget } from './ui/select';
import { discoverAndSelect } from './ui/select';
import { syncComponents } from './core/repoSync';
import { printRegistries } from './core/registries';
import { checkDependencies } from './core/depCheck';
import { buildCatalog, catalogFromComponents, catalogToJson, printCatalog } from './core/catalog';
import {
  printProjectsUsing,
  printComponentsOfProject,
  printUsageSummary,
} from './core/usage';
import { analyzeLayers, printLayers, toLayersJson, flattenLayersJson } from './core/depsTree';
import {
  getVirtualSpaces,
  getVirtualSpace,
  saveVirtualSpace,
  patchVirtualSpace,
  removeVirtualSpace,
  resolveVsComponents,
  membersFromComponents,
  vsStateFilePath,
  VsMember,
} from './core/vsStore';
import {
  getAiConfig,
  setAiConfig,
  maskApiKey,
  aiStateFilePath,
} from './core/aiConfig';
import { runAiFlow } from './ui/aiFlow';
import { listSpecs, loadSpec, workflowsDir } from './core/workflow/store';
import { renderWorkflow, runWorkflow } from './core/workflow/engine';
import { listTemplates, loadTemplate, removeTemplate, templatesDir } from './core/workflow/templates';
import { runLogFile, tailRunLog, logsDir } from './utils/fileLogger';
import { StepContext, WorkflowSpec } from './core/workflow/types';

/**
 * 依据 CLI 选项与配置解析出一个扫描目标。
 * 优先级：--dir > --projects > --components > 配置/内置默认（defaultKind）。
 * 三个 scope 选项都会生效：显式给出哪个就扫哪个，均未给出时回退默认根。
 */
function pickScanTarget(
  config: SejuaniConfig,
  opts: { dir?: string; projects?: string; components?: string },
  defaultKind: 'projects' | 'components'
): ScanTarget {
  if (opts.dir) return { dir: path.resolve(opts.dir) };
  if (opts.projects) return { dir: path.resolve(opts.projects) };
  if (opts.components) return { dir: path.resolve(opts.components) };
  return resolveScanTarget(config.roots[defaultKind]);
}

/** 解析 projects 根扫描目标（供需要工程列表的命令使用）。 */
function projectsTarget(config: SejuaniConfig, opts: { projects?: string }): ScanTarget {
  return opts.projects ? { dir: path.resolve(opts.projects) } : resolveScanTarget(config.roots.projects);
}

/** 解析 components 根扫描目标（供需要 catalog 的命令使用）。 */
function componentsTarget(config: SejuaniConfig, opts: { components?: string }): ScanTarget {
  return opts.components ? { dir: path.resolve(opts.components) } : resolveScanTarget(config.roots.components);
}

/**
 * 统一的组件解析：若传入 --vs 则读虚拟空间成员，否则按扫描目标发现。
 * 虚拟空间不存在时抛错。requireYarnLock 时会过滤无 yarn.lock 的成员。
 */
async function resolveComponents(
  config: SejuaniConfig,
  opts: { dir?: string; projects?: string; components?: string; vs?: string },
  defaultKind: 'projects' | 'components',
  discoverOpts: { requireYarnLock?: boolean } = {}
): Promise<Component[]> {
  if (opts.vs) {
    const resolved = resolveVsComponents(opts.vs);
    if (!resolved) {
      throw new Error(`虚拟空间不存在: ${opts.vs}（sjn vs 查看列表）`);
    }
    if (resolved.missing.length > 0) {
      logger.warn(`虚拟空间 ${opts.vs} 有 ${resolved.missing.length} 个成员目录已失效，已跳过: ${resolved.missing.join(', ')}`);
    }
    logger.step(`使用虚拟空间 ${chalk.cyan(opts.vs)}（${resolved.components.length} 个组件）`);
    return discoverOpts.requireYarnLock
      ? resolved.components.filter((c) => c.yarnLockPath)
      : resolved.components;
  }
  const target = pickScanTarget(config, opts, defaultKind);
  return discoverComponents(target.dir, {
    requireYarnLock: discoverOpts.requireYarnLock,
    maxDepth: target.maxDepth,
  });
}

const program = new Command();

// 从 package.json 动态读取版本，避免硬编码与实际发布版本不一致
function readPkgVersion(): string {
  try {
    // dist/index.js 与 src/index.ts 均位于包根的一级子目录，package.json 在上层
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

program
  .name('sejuani')
  .description(
    '批量管理前端工程 / 组件（projects & components）的 package.json / yarn.lock、仓同步与依赖治理的终端工具 (别名: sjn)'
  )
  .version(readPkgVersion());

// 默认 / start：交互式向导
program
  .command('start', { isDefault: true })
  .description('启动交互式向导（默认命令）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .action(async (opts) => {
    await runWizard(opts.config);
  });

// 替换 yarn.lock 中的 resolved URL
program
  .command('replace-url')
  .description('批量替换 yarn.lock 中 resolved 的 URL 片段')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .requiredOption('-f, --from <from>', '要替换的 URL 片段')
  .requiredOption('-t, --to <to>', '替换为的 URL 片段')
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .option('--dry-run', '仅预览不写入', false)
  .option('--no-backup', '不生成 .bak 备份')
  .option('-y, --yes', '跳过确认', false)
  .option('--diff', '显示 diff 明细', false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const comps = await resolveComponents(config, opts, 'components', { requireYarnLock: true });
    const changes = buildReplaceUrlChanges(comps, opts.from, opts.to);
    await runChanges(changes, {
      dryRun: opts.dryRun,
      backup: opts.backup,
      yes: opts.yes,
      showDiff: opts.diff,
    });
  });

// 修改 package.json version
program
  .command('set-version')
  .description('批量修改 package.json 的 version（bump 或指定值，保留 -后缀）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('-b, --bump <level>', '递增级别: patch|minor|major')
  .option('-t, --to <version>', '设为指定版本，如 1.2.0 或 1.2.0-chery')
  .option('--keep-suffix', 'set 模式下若未写后缀则沿用当前后缀', false)
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .option('--dry-run', '仅预览不写入', false)
  .option('--no-backup', '不生成 .bak 备份')
  .option('-y, --yes', '跳过确认', false)
  .option('--diff', '显示 diff 明细', false)
  .action(async (opts) => {
    if (!opts.bump && !opts.to) {
      logger.error('请提供 --bump <level> 或 --to <version> 之一。');
      process.exitCode = 1;
      return;
    }
    const config = loadConfig(opts.config);
    const comps = await resolveComponents(config, opts, 'components');
    const changes = opts.bump
      ? buildVersionChanges(comps, { mode: 'bump', bump: opts.bump as BumpType })
      : buildVersionChanges(comps, { mode: 'set', target: opts.to, keepSuffix: opts.keepSuffix });
    await runChanges(changes, {
      dryRun: opts.dryRun,
      backup: opts.backup,
      yes: opts.yes,
      showDiff: opts.diff,
    });
  });

// 修改 package.json name
program
  .command('set-name')
  .description('批量修改 package.json 的 name（查找替换或设为固定值）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--find <find>', '要查找的子串')
  .option('--replace <replace>', '替换为', '')
  .option('-t, --to <name>', '整体设为固定 name')
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .option('--dry-run', '仅预览不写入', false)
  .option('--no-backup', '不生成 .bak 备份')
  .option('-y, --yes', '跳过确认', false)
  .option('--diff', '显示 diff 明细', false)
  .action(async (opts) => {
    if (!opts.find && !opts.to) {
      logger.error('请提供 --find <str> 或 --to <name> 之一。');
      process.exitCode = 1;
      return;
    }
    const config = loadConfig(opts.config);
    const comps = await resolveComponents(config, opts, 'components');
    const changes = opts.to
      ? buildNameChanges(comps, { target: opts.to })
      : buildNameChanges(comps, { find: opts.find, replace: opts.replace });
    await runChanges(changes, {
      dryRun: opts.dryRun,
      backup: opts.backup,
      yes: opts.yes,
      showDiff: opts.diff,
    });
  });

// 创建虚拟空间（软链）
program
  .command('link')
  .description('把选定组件以软链聚合到一个虚拟空间目录')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .requiredOption('-i, --into <into>', '虚拟空间目录')
  .option('--vs <name>', '物化指定命名虚拟空间的成员（替代扫描域组件仓）')
  .option('--force', '覆盖已存在的同名软链', false)
  .option('--dry-run', '仅预览不创建', false)
  .option('-y, --yes', '跳过确认', false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const comps = await resolveComponents(config, opts, 'components');
    await createVirtualSpace(comps, {
      into: opts.into,
      force: opts.force,
      dryRun: opts.dryRun,
      yes: opts.yes,
    });
    if (opts.vs && !opts.dryRun) patchVirtualSpace(opts.vs, { linkedDir: path.resolve(opts.into) });
  });

// Feature A - 仓同步（仅针对组件）
program
  .command('sync')
  .description('仓同步（仅组件）：对每个组件 npm pack → npm publish → 清理 tgz')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .option('--pack-registry <url>', 'pack 源 registry（覆盖配置）')
  .option('--publish-registry <url>', 'publish 目标 registry（覆盖配置）')
  .option('--work-dir <dir>', '执行 pack/publish 的工作目录（默认临时目录）')
  .option('--pack-retries <n>', 'pack 找不到版本(ETARGET)时的重试次数（应对发布后同步延迟）', (v) => parseInt(v, 10))
  .option('--pack-wait <sec>', '每次 pack 重试的等待秒数（默认 5）', (v) => parseInt(v, 10))
  .option('--dry-run', '仅打印命令不执行', false)
  .option('-y, --yes', '跳过确认', false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    let comps;
    if (opts.vs) {
      comps = await resolveComponents(config, opts, 'components');
    } else {
      const target = opts.dir ? { dir: path.resolve(opts.dir) } : componentsTarget(config, opts);
      comps = await discoverComponents(target.dir, { maxDepth: target.maxDepth });
    }
    await syncComponents(comps, {
      packRegistry: opts.packRegistry ?? config.registries.pack,
      publishRegistry: opts.publishRegistry ?? config.registries.publish,
      workDir: opts.workDir,
      dryRun: opts.dryRun,
      yes: opts.yes,
      packRetries: opts.packRetries,
      packRetryDelayMs: opts.packWait != null ? opts.packWait * 1000 : undefined,
    });
  });

// Feature A2 - 完整发包（构建 → pack → publish）
program
  .command('release [dir]')
  .description('完整发包：在组件目录依次执行构建步骤（yarn install/lib/gaia …）后 pack → publish（默认当前目录）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--components [dir]', '批量：扫描组件库根目录下所有组件（省略 dir 时用配置根）')
  .option('--no-build', '跳过构建步骤，仅 pack+publish（等价 sync）')
  .option('--steps <list>', '覆盖构建步骤（分号分隔，如 "yarn install;yarn lib;gaia pub-isd prod"）')
  .option('--pack-registry <url>', 'pack 源 registry（覆盖配置）')
  .option('--publish-registry <url>', 'publish 目标 registry（覆盖配置）')
  .option('--work-dir <dir>', '执行 pack/publish 的工作目录（默认临时目录）')
  .option('--pack-retries <n>', 'pack 找不到版本(ETARGET)时的重试次数（应对发布后同步延迟）', (v) => parseInt(v, 10))
  .option('--pack-wait <sec>', '每次 pack 重试的等待秒数（默认 5）', (v) => parseInt(v, 10))
  .option('--dry-run', '仅打印命令不执行', false)
  .option('-y, --yes', '跳过确认', false)
  .action(async (dir: string | undefined, opts) => {
    const config = loadConfig(opts.config);

    // 构建步骤：--no-build → 空；--steps → 覆盖；否则用配置默认
    let buildSteps: string[];
    if (opts.build === false) {
      buildSteps = [];
    } else if (opts.steps) {
      buildSteps = String(opts.steps).split(';').map((s: string) => s.trim()).filter(Boolean);
    } else {
      buildSteps = config.buildSteps ?? [];
    }

    // 目标：--components 批量；否则把 dir/当前目录当作单个组件
    let comps;
    if (opts.components !== undefined) {
      const root = typeof opts.components === 'string' ? opts.components : resolveScanTarget(config.roots.components).dir;
      const maxDepth = typeof opts.components === 'string' ? undefined : resolveScanTarget(config.roots.components).maxDepth;
      comps = await discoverComponents(root, { maxDepth });
    } else {
      const one = readSingleComponent(dir ?? process.cwd());
      if (!one) {
        logger.error(`当前目录未找到 package.json: ${path.resolve(dir ?? process.cwd())}`);
        process.exitCode = 1;
        return;
      }
      comps = [one];
    }

    await syncComponents(comps, {
      packRegistry: opts.packRegistry ?? config.registries.pack,
      publishRegistry: opts.publishRegistry ?? config.registries.publish,
      workDir: opts.workDir,
      dryRun: opts.dryRun,
      yes: opts.yes,
      buildSteps,
      packRetries: opts.packRetries,
      packRetryDelayMs: opts.packWait != null ? opts.packWait * 1000 : undefined,
    });
  });

// Feature B - 枚举 yarn.lock 仓库
program
  .command('registries')
  .description('枚举所选组件 yarn.lock 中出现的所有仓库（registry base）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--by-component', '展开每个仓库涉及的组件', false)
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const comps = await resolveComponents(config, opts, 'components', { requireYarnLock: true });
    printRegistries(comps, opts.byComponent);
  });

// Feature C - 校验依赖是否存在
program
  .command('check-deps')
  .description('批量校验 yarn.lock 中 resolved 依赖 URL 是否可访问')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--concurrency <n>', '并发数', (v) => parseInt(v, 10), 12)
  .option('--timeout <ms>', '单请求超时(ms)', (v) => parseInt(v, 10), 8000)
  .option('--only-missing', '只显示异常项', false)
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const comps = await resolveComponents(config, opts, 'components', { requireYarnLock: true });
    await checkDependencies(comps, {
      concurrency: opts.concurrency,
      timeout: opts.timeout,
      onlyMissing: opts.onlyMissing,
    });
  });

// Feature 4 - 组件库清单
program
  .command('catalog')
  .description('列出组件库下每个组件的名称与版本，可导出 JSON 文件')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
  .option('--json [file]', '以 JSON 输出；给文件名则写入该文件，否则打印到 stdout')
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    let catalog;
    if (opts.vs) {
      const comps = await resolveComponents(config, opts, 'components');
      catalog = catalogFromComponents(comps);
    } else {
      const t = componentsTarget(config, opts);
      catalog = await buildCatalog(t.dir, t.maxDepth);
    }
    if (opts.json !== undefined) {
      const arr = catalogToJson(catalog);
      const json = JSON.stringify(arr, null, 2);
      if (typeof opts.json === 'string') {
        fs.writeFileSync(path.resolve(opts.json), json + '\n');
        logger.success(`已导出组件清单 JSON: ${path.resolve(opts.json)}（${arr.length} 个组件）`);
      } else {
        logger.info(json);
      }
    } else {
      printCatalog(catalog, false);
    }
  });

// 组件依赖树分析：按层级划分 layer-0 → layer-x，可导出 JSON / 存为虚拟空间
program
  .command('deps-tree [dir]')
  .alias('layers')
  .description('分析组件库内部组件间依赖并拓扑分层（layer-0 → x），可导出 JSON')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--vs <name>', '只分析某命名虚拟空间内的组件')
  .option('--json [file]', '以 JSON 输出；给文件名则写入文件，否则打印到 stdout')
  .option('--save <vsName>', '把分析结果（含层级）保存为虚拟空间')
  .action(async (dir: string | undefined, opts) => {
    const config = loadConfig(opts.config);
    let comps: Component[];
    let root: string;
    if (opts.vs) {
      comps = await resolveComponents(config, opts, 'components');
      root = `vs:${opts.vs}`;
    } else {
      const t = dir ? { dir: path.resolve(dir) } : componentsTarget(config, opts);
      comps = await discoverComponents(t.dir, { maxDepth: t.maxDepth });
      root = t.dir;
    }
    const result = analyzeLayers(comps, root);

    if (opts.json !== undefined) {
      const json = JSON.stringify(toLayersJson(result), null, 2);
      if (typeof opts.json === 'string') {
        fs.writeFileSync(path.resolve(opts.json), json + '\n');
        logger.success(`已导出分层 JSON: ${path.resolve(opts.json)}`);
      } else {
        logger.info(json);
      }
    } else {
      printLayers(result);
    }

    if (opts.save) {
      const members: VsMember[] = [];
      const layers: string[][] = result.layers.map((l) => l.map((c) => c.name));
      for (const layer of result.layers) {
        for (const c of layer) members.push({ name: path.basename(c.dir), pkgName: c.name, dir: c.dir });
      }
      for (const c of result.cycles) members.push({ name: path.basename(c.dir), pkgName: c.name, dir: c.dir });
      saveVirtualSpace(opts.save, { members, layers, source: `deps-tree:${root}` });
      logger.success(`已保存为虚拟空间 ${chalk.bold(opts.save)}（${members.length} 个组件，${layers.length} 层）`);
      logger.info(chalk.dim(`使用: sjn <命令> --vs ${opts.save}`));
    }
  });

// 虚拟空间(vs) 管理
program
  .command('vs [action] [name] [arg]')
  .description('虚拟空间管理：vs（列表）/ vs show <名> / vs create <名> [--from-layers f|--from-catalog] / vs rm <名>')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--from-layers <file>', 'create：从 deps-tree 导出的 layers.json 创建')
  .option('--from-catalog', 'create：从当前域组件库全量创建', false)
  .option('--layers <indexes>', 'create：仅选取指定层（逗号分隔，如 0,1），需配合 --from-layers')
  .option('--into <dir>', 'link：物化软链的目标目录')
  .option('--force', 'link：覆盖已存在的同名软链', false)
  .option('-y, --yes', '跳过确认', false)
  .action(async (action: string | undefined, name: string | undefined, _arg, opts) => {
    const config = loadConfig(opts.config);
    await handleVs(action, name, opts, config);
  });


// Feature 1 - who-uses
program
  .command('who-uses <component>')
  .description('查询某组件被哪些工程使用')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .action(async (component: string, opts) => {
    const config = loadConfig(opts.config);
    const projT = projectsTarget(config, opts);
    const compT = componentsTarget(config, opts);
    const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
    const catalog = await buildCatalog(compT.dir, compT.maxDepth);
    printProjectsUsing(component, projects, catalog);
  });

// Feature 2 - project-deps
program
  .command('project-deps <project>')
  .description('查询某工程用了组件库中的哪些组件')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .action(async (project: string, opts) => {
    const config = loadConfig(opts.config);
    const projT = projectsTarget(config, opts);
    const compT = componentsTarget(config, opts);
    const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
    const catalog = await buildCatalog(compT.dir, compT.maxDepth);
    printComponentsOfProject(project, projects, catalog);
  });

// Feature 3 - usage 统计
program
  .command('usage')
  .description('统计所有工程对组件库中组件的使用情况')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--json', '以 JSON 输出', false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const projT = projectsTarget(config, opts);
    const compT = componentsTarget(config, opts);
    const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
    const catalog = await buildCatalog(compT.dir, compT.maxDepth);
    printUsageSummary(projects, catalog, opts.json);
  });

// Feature 5 - upgrade
program
  .command('upgrade')
  .description('按组件库 catalog 的精确版本升级工程内组件依赖（默认全量，--only 指定组件）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--projects <dir>', '工程根目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('-o, --only <names>', '仅升级指定组件（逗号分隔多个，如 @f6p/a,@f6p/b）')
  .option('--dry-run', '仅预览不写入', false)
  .option('--no-backup', '不生成 .bak 备份')
  .option('-y, --yes', '跳过确认', false)
  .option('--diff', '显示 diff 明细', false)
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const projT = projectsTarget(config, opts);
    const compT = componentsTarget(config, opts);
    logger.step('扫描工程与组件库 ...');
    const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
    const catalog = await buildCatalog(compT.dir, compT.maxDepth);
    const only = opts.only
      ? String(opts.only).split(',').map((s: string) => s.trim()).filter(Boolean)
      : undefined;
    logger.info(
      chalk.dim(
        `工程 ${projects.length} 个，catalog ${catalog.size} 个组件。` +
          (only ? `仅升级指定 ${only.length} 个组件。` : '全量升级。')
      )
    );
    await runChanges(buildUpgradeChanges(projects, catalog, { only }), {
      dryRun: opts.dryRun,
      backup: opts.backup,
      yes: opts.yes,
      showDiff: opts.diff,
    });
    if (!opts.dryRun) {
      logger.warn('升级仅改写 package.json，未改动 yarn.lock；请在各工程重新执行 yarn install。');
    }
  });

// Feature F - guide 中文手册
program
  .command('guide')
  .description('打印完整中文使用手册')
  .action(() => {
    printGuide();
  });

// 域设置：查看 / 切换 chery|foton|saas
program
  .command('domain [name]')
  .description('查看或切换域（chery/foton/saas）；切换后影响工程/组件仓库与 registry')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .action((name: string | undefined, opts) => {
    const config = loadConfig(opts.config);
    if (!name) {
      printDomains(config);
      return;
    }
    if (!config.domains[name]) {
      logger.error(`未知域: ${name}。可选: ${Object.keys(config.domains).join(' / ')}`);
      process.exitCode = 1;
      return;
    }
    setActiveDomain(name);
    const d = config.domains[name];
    logger.success(`已切换到域 ${chalk.bold(name)}（${d.label}）`);
    logger.info(chalk.dim(`  工程根: ${d.roots.projects.root}`));
    logger.info(chalk.dim(`  组件库: ${d.roots.components.root}`));
  });

// registry 地址设置：按域持久化 pack / publish（供 release·sync 使用）
program
  .command('registry [action] [url]')
  .description('设置/查看 release·sync 使用的 pack/publish registry（按域持久化到 state.json）')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-D, --domain <key>', '目标域（默认当前域）')
  .action((action: string | undefined, url: string | undefined, opts) => {
    const config = loadConfig(opts.config);
    const domain = opts.domain ?? config.activeDomain;
    if (!config.domains[domain]) {
      logger.error(`未知域: ${domain}。可选: ${Object.keys(config.domains).join(' / ')}`);
      process.exitCode = 1;
      return;
    }
    handleRegistry(action, url, domain, config);
  });

// 自定义短链(alias)：把常用的长命令取个短名
program
  .command('alias [action] [name] [command]')
  .description('自定义短链：alias set <名> "<命令>" / alias rm <名> / alias（查看列表）')
  .allowUnknownOption(true)
  .action((action: string | undefined, name: string | undefined, command: string | undefined) => {
    if (!action || action === 'list' || action === 'ls') {
      printAliases();
      return;
    }
    if (action === 'set' || action === 'add') {
      if (!name || !command) {
        logger.error('用法: sjn alias set <名称> "<完整命令>"，例: sjn alias set r "release --no-build"');
        process.exitCode = 1;
        return;
      }
      const reserved = new Set(program.commands.map((c) => c.name()));
      if (reserved.has(name)) {
        logger.error(`"${name}" 是内置命令，不能用作短链名。`);
        process.exitCode = 1;
        return;
      }
      setAlias(name, command.trim());
      logger.success(`已设置短链 ${chalk.bold(name)} = ${chalk.cyan(command.trim())}`);
      logger.info(chalk.dim(`现在可用: sjn ${name} [额外参数]`));
      return;
    }
    if (action === 'rm' || action === 'remove' || action === 'del') {
      if (!name) {
        logger.error('用法: sjn alias rm <名称>');
        process.exitCode = 1;
        return;
      }
      if (removeAlias(name)) logger.success(`已删除短链 ${chalk.bold(name)}`);
      else logger.warn(`短链不存在: ${name}`);
      return;
    }
    logger.error(`未知操作: ${action}。可用: list / set / rm`);
    process.exitCode = 1;
  });

// AI 工作流：选组件 + 自然语言描述 → 生成可审阅工作流 → 确认后确定性执行
program
  .command('ai [description...]')
  .description('AI 工作流：选组件并用自然语言描述，生成可审阅工作流并（确认后）执行')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('-d, --dir <dir>', '选组件的扫描目录（覆盖配置）')
  .option('--components <dir>', '组件库根目录（覆盖配置）')
  .option('--template <name>', '套用已存模板（不调 AI，按当前选中组件重绑定）')
  .option('--save-template <name>', '把本次生成的工作流存为模板')
  .option('--dry-run', '仅规划并预览工作流，不执行', false)
  .option('-y, --yes', '跳过确认（含危险步骤，慎用）', false)
  .action(async (description: string[] | undefined, opts) => {
    // ai config 子命令走单独命令；这里仅处理工作流
    const config = loadConfig(opts.config);
    await runAiFlow(config, {
      dir: opts.dir,
      components: opts.components,
      description: description && description.length ? description.join(' ') : undefined,
      template: opts.template,
      saveTemplate: opts.saveTemplate,
      dryRun: opts.dryRun,
      yes: opts.yes,
    });
  });

// AI 配置：show / set-key / set-base / set-model
program
  .command('ai-config [action] [value]')
  .alias('aicfg')
  .description('AI 接入配置：ai-config show | set-key <k> | set-base <url> | set-model <m>')
  .action((action: string | undefined, value: string | undefined) => {
    handleAiConfig(action, value);
  });

// 工作流管理：list / show <id> / run <id> / resume <id> / template / log <id>
program
  .command('flow [action] [id] [arg]')
  .description('管理已保存的 AI 工作流：flow list | show <id> | run <id> | resume <id> | template [list|show <n>|rm <n>] | log <id>')
  .option('-c, --config <file>', '指定 sejuani.config.json')
  .option('--dry-run', 'run/show：仅预览不执行', false)
  .option('-y, --yes', 'run/resume：跳过确认', false)
  .action(async (action: string | undefined, id: string | undefined, arg: string | undefined, opts) => {
    const config = loadConfig(opts.config);
    await handleFlow(action, id, arg, opts, config);
  });

// 日志目录：打印 NDJSON 日志存放位置
program
  .command('logs')
  .description('打印 sejuani 日志目录（每日 NDJSON + 每次运行日志）')
  .action(() => {
    logger.title('sejuani 日志');
    logger.info(`  每日日志目录: ${chalk.cyan(logsDir())}`);
    logger.info(`  每次运行日志: ${chalk.cyan(workflowsDir())}/<id>.run.log`);
    logger.info(chalk.dim('\n查看某次运行原文: sjn flow log <id>'));
  });

// Feature F - 顶层帮助：前置 banner + 后置分组总览/全局选项/示例
program.addHelpText(
  'beforeAll',
  `
${chalk.bold.cyan('Sejuani')} ${chalk.dim('(sjn)')} · 前端工程 / 组件批量与依赖治理终端工具
${chalk.dim('扫描工程(projects)与组件库(components)，批量编辑 package.json / yarn.lock，并提供仓同步与依赖治理。')}
`
);

program.addHelpText(
  'after',
  `
${chalk.bold('命令分类:')}
  ${chalk.bold('交互式')}    start(默认)                     启动向导，菜单化驱动全部能力
  ${chalk.bold('批量编辑')}  replace-url / set-version /       写操作，均走预览→确认→.bak备份→写入
              set-name / upgrade / link / sync
  ${chalk.bold('依赖治理')}  registries / check-deps /         只读，枚举仓库 / 校验依赖 / 依赖分层
              deps-tree
  ${chalk.bold('查询统计')}  catalog / who-uses /              只读，组件清单 / 反查 / 用量统计
              project-deps / usage
  ${chalk.bold('虚拟空间')}  vs [list|show|create|rm|link]     命名组件集合，可用 --vs 引用 / 物化软链
  ${chalk.bold('帮助')}      guide                             打印完整中文手册
  ${chalk.bold('域设置')}  domain [name]                     查看/切换域 chery·foton·saas

${chalk.bold('通用选项:')}
  -c, --config <file>   指定 sejuani.config.json（默认就近向上查找，无则用内置默认）
  -d, --dir <dir>       直接指定扫描目录（优先级最高）
  --projects <dir>      工程根目录（覆盖配置）
  --components <dir>    组件库根目录（覆盖配置）
  ${chalk.dim('扫描目标优先级：--dir > --projects > --components > 配置/内置默认。')}

${chalk.bold('写操作安全选项（replace-url / set-version / set-name / upgrade）:')}
  --dry-run   仅预览不写入      -y, --yes   跳过确认
  --no-backup 不生成 .bak 备份   --diff      展示逐行 diff

${chalk.bold('典型示例:')}
  ${chalk.dim('# 交互式向导（推荐）')}
  $ sjn

  ${chalk.dim('# 组件库清单 / 用量统计 / 反查')}
  $ sjn catalog
  $ sjn catalog --json catalog.json        # 导出所有组件名称+版本到文件
  $ sjn usage
  $ sjn who-uses @f6p/account-book-shop
  $ sjn project-deps my-app

  ${chalk.dim('# 升级工程内组件到 catalog 精确版本（先干跑）')}
  $ sjn upgrade --dry-run --diff
  $ sjn upgrade -y

  ${chalk.dim('# 依赖治理')}
  $ sjn registries --by-component
  $ sjn check-deps --only-missing

  ${chalk.dim('# 依赖分层 + 虚拟空间')}
  $ sjn deps-tree                          # 打印 layer-0→x
  $ sjn deps-tree --json layers.json       # 导出按层划分的 JSON
  $ sjn deps-tree --save core              # 分析并存为虚拟空间 core
  $ sjn vs                                 # 查看虚拟空间列表
  $ sjn vs create core --from-layers layers.json --layers 0,1
  $ sjn set-version --vs core -b patch     # 对虚拟空间批量操作
  $ sjn vs link core --into ./.space       # 物化为软链目录

  ${chalk.dim('# 仓同步（先干跑查看命令）')}
  $ sjn sync --dry-run

  ${chalk.dim('# 指定配置 / 临时换扫描路径')}
  $ sjn usage -c ./sejuani.config.json
  $ sjn catalog --components /path/to/lib-workspace

  ${chalk.dim('# 完整手册')}
  $ sjn guide

${chalk.bold('域(domain):')}
  chery(奇瑞) / foton(福田) / saas 各对应不同的工程仓库与组件仓库。
  ${chalk.dim('sjn domain            # 查看当前域与列表')}
  ${chalk.dim('sjn domain foton      # 切换到福田域（持久化到 ~/.sejuani/state.json）')}

${chalk.bold('registry 地址（release·sync 的 pack/publish）:')}
  pack 与 publish 可分别设置，按域持久化，优先级高于配置/内置默认。
  ${chalk.dim('sjn registry                        # 查看当前域生效的 pack/publish')}
  ${chalk.dim('sjn registry set-pack <url>         # 设置拉取源')}
  ${chalk.dim('sjn registry set-publish <url>      # 设置发布目标（与 pack 可不同）')}
  ${chalk.dim('sjn registry reset                  # 重置为默认    -D <域> 针对指定域')}

${chalk.bold('短链(alias):')}
  把常用长命令取个短名，运行时自动展开，额外参数会追加在后面。
  ${chalk.dim('sjn alias set r "release --no-build"   # 定义 sjn r = sjn release --no-build')}
  ${chalk.dim('sjn r --dry-run                        # 等价 sjn release --no-build --dry-run')}
  ${chalk.dim('sjn alias           # 查看全部短链    sjn alias rm r   # 删除')}
`
);

function printDomains(config: SejuaniConfig): void {
  logger.info(chalk.bold('可用域:'));
  for (const [key, d] of Object.entries(config.domains)) {
    const active = key === config.activeDomain;
    const mark = active ? chalk.green('● 当前') : chalk.dim('○    ');
    logger.info(`  ${mark} ${chalk.bold(key)}  ${chalk.dim(d.label)}`);
    logger.info(chalk.dim(`         工程 ${d.roots.projects.root}`));
    logger.info(chalk.dim(`         组件 ${d.roots.components.root}`));
  }
  logger.info(chalk.dim('\n切换: sjn domain <name>   例: sjn domain foton'));
}

function printAliases(): void {
  const aliases = getAliases();
  const names = Object.keys(aliases).sort();
  logger.title('自定义短链');
  if (names.length === 0) {
    logger.info(chalk.dim('  (暂无) 用 sjn alias set <名> "<命令>" 添加，例: sjn alias set r "release --no-build"'));
  } else {
    for (const n of names) {
      logger.info(`  ${chalk.bold(n)}  ${chalk.dim('→')}  sjn ${chalk.cyan(aliases[n])}`);
    }
  }
  logger.info(chalk.dim(`\n存储: ${aliasStateFilePath()}`));
}

/** 打印某域生效的 pack/publish（含来源标注）。 */
function printRegistryConfig(domain: string, config: SejuaniConfig): void {
  const base = config.domains[domain].registries;
  const override = getRegistryOverride(domain) ?? {};
  const packSrc = override.pack ? chalk.green('[已设置]') : chalk.dim('[域默认]');
  const pubSrc = override.publish ? chalk.green('[已设置]') : chalk.dim('[域默认]');
  const pack = override.pack ?? base.pack;
  const publish = override.publish ?? base.publish;
  logger.title(`registry 设置·域 ${domain}（${config.domains[domain].label}）`);
  logger.info(`  pack    ${packSrc}  ${chalk.cyan(pack)}`);
  logger.info(`  publish ${pubSrc}  ${chalk.cyan(publish)}`);
  logger.info(
    chalk.dim(
      '\n设置: sjn registry set-pack <url> / set-publish <url>   重置: sjn registry reset'
    )
  );
  logger.info(chalk.dim(`存储: ${registryStateFilePath()}`));
}

/** registry 子命令分发：show / set-pack / set-publish / reset */
function handleRegistry(
  action: string | undefined,
  url: string | undefined,
  domain: string,
  config: SejuaniConfig
): void {
  if (!action || action === 'show' || action === 'list' || action === 'ls') {
    printRegistryConfig(domain, config);
    return;
  }
  if (action === 'set-pack' || action === 'pack') {
    if (!url) {
      logger.error('用法: sjn registry set-pack <url>');
      process.exitCode = 1;
      return;
    }
    setRegistry(domain, { pack: url.trim() });
    logger.success(`已设置域 ${chalk.bold(domain)} 的 pack registry = ${chalk.cyan(url.trim())}`);
    return;
  }
  if (action === 'set-publish' || action === 'publish') {
    if (!url) {
      logger.error('用法: sjn registry set-publish <url>');
      process.exitCode = 1;
      return;
    }
    setRegistry(domain, { publish: url.trim() });
    logger.success(`已设置域 ${chalk.bold(domain)} 的 publish registry = ${chalk.cyan(url.trim())}`);
    return;
  }
  if (action === 'reset' || action === 'clear' || action === 'rm') {
    if (clearRegistryOverride(domain)) logger.success(`已重置域 ${chalk.bold(domain)} 的 registry 为配置/内置默认`);
    else logger.warn(`域 ${domain} 未设置过 registry 覆盖`);
    return;
  }
  logger.error(`未知操作: ${action}。可用: show / set-pack / set-publish / reset`);
  process.exitCode = 1;
}

function printVsList(): void {
  const spaces = getVirtualSpaces();
  const names = Object.keys(spaces).sort();
  logger.title('虚拟空间 (vs)');
  if (names.length === 0) {
    logger.info(chalk.dim('  (暂无) 用 sjn deps-tree --save <名> 或 sjn vs create <名> 创建'));
  } else {
    for (const n of names) {
      const vs = spaces[n];
      const layerNote = vs.layers ? ` · ${vs.layers.length} 层` : '';
      const linkNote = vs.linkedDir ? ` · 软链→${vs.linkedDir}` : '';
      logger.info(`  ${chalk.bold(n)}  ${chalk.dim(`${vs.members.length} 个组件${layerNote}${linkNote}`)}`);
    }
  }
  logger.info(chalk.dim(`\n存储: ${vsStateFilePath()}`));
}

function printVsDetail(name: string): void {
  const vs = getVirtualSpace(name);
  if (!vs) {
    logger.error(`虚拟空间不存在: ${name}`);
    process.exitCode = 1;
    return;
  }
  logger.title(`虚拟空间 ${name}`);
  logger.info(chalk.dim(`来源: ${vs.source ?? '?'}   创建: ${vs.createdAt}   更新: ${vs.updatedAt}`));
  if (vs.linkedDir) logger.info(chalk.dim(`软链目录: ${vs.linkedDir}`));
  if (vs.layers && vs.layers.length > 0) {
    vs.layers.forEach((layer, i) => {
      logger.info(chalk.bold(`\nlayer-${i} ${chalk.dim(`(${layer.length})`)}`));
      for (const p of layer) logger.info(`  ${chalk.cyan(p)}`);
    });
    const inLayers = new Set(vs.layers.flat());
    const extra = vs.members.filter((m) => m.pkgName && !inLayers.has(m.pkgName));
    if (extra.length > 0) {
      logger.info(chalk.bold(`\n其它/环 ${chalk.dim(`(${extra.length})`)}`));
      for (const m of extra) logger.info(`  ${chalk.yellow(m.pkgName ?? m.name)}`);
    }
  } else {
    for (const m of vs.members) logger.info(`  ${chalk.cyan(m.pkgName ?? m.name)}  ${chalk.dim(m.dir)}`);
  }
  logger.success(`\n共 ${vs.members.length} 个组件。`);
}

/** vs 子命令分发：list / show / create / rm / link */
async function handleVs(
  action: string | undefined,
  name: string | undefined,
  opts: {
    fromLayers?: string;
    fromCatalog?: boolean;
    layers?: string;
    into?: string;
    force?: boolean;
    yes?: boolean;
    components?: string;
  },
  config: SejuaniConfig
): Promise<void> {
  if (!action || action === 'list' || action === 'ls') {
    printVsList();
    return;
  }
  if (action === 'show') {
    if (!name) {
      logger.error('用法: sjn vs show <名称>');
      process.exitCode = 1;
      return;
    }
    printVsDetail(name);
    return;
  }
  if (action === 'rm' || action === 'remove' || action === 'del') {
    if (!name) {
      logger.error('用法: sjn vs rm <名称>');
      process.exitCode = 1;
      return;
    }
    if (removeVirtualSpace(name)) logger.success(`已删除虚拟空间 ${chalk.bold(name)}`);
    else logger.warn(`虚拟空间不存在: ${name}`);
    return;
  }
  if (action === 'link') {
    if (!name) {
      logger.error('用法: sjn vs link <名称> --into <dir>');
      process.exitCode = 1;
      return;
    }
    const resolved = resolveVsComponents(name);
    if (!resolved) {
      logger.error(`虚拟空间不存在: ${name}`);
      process.exitCode = 1;
      return;
    }
    if (resolved.missing.length > 0) {
      logger.warn(`有 ${resolved.missing.length} 个成员目录已失效，已跳过: ${resolved.missing.join(', ')}`);
    }
    const into = path.resolve(opts.into ?? path.join(process.cwd(), name));
    await createVirtualSpace(resolved.components, { into, force: !!opts.force, dryRun: false, yes: !!opts.yes });
    patchVirtualSpace(name, { linkedDir: into });
    return;
  }
  if (action === 'create' || action === 'add') {
    if (!name) {
      logger.error('用法: sjn vs create <名称> [--from-layers <file> | --from-catalog]');
      process.exitCode = 1;
      return;
    }
    let members: VsMember[] = [];
    let layers: string[][] | undefined;
    let source = 'manual';
    if (opts.fromLayers) {
      const file = path.resolve(opts.fromLayers);
      if (!fs.existsSync(file)) {
        logger.error(`layers 文件不存在: ${file}`);
        process.exitCode = 1;
        return;
      }
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      const flat = flattenLayersJson(json);
      let selected = flat.members;
      if (opts.layers) {
        const idx = new Set(
          String(opts.layers)
            .split(',')
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !Number.isNaN(n))
        );
        selected = flat.members.filter((m) => idx.has(m.layer));
        layers = flat.layers.filter((_, i) => idx.has(i));
      } else {
        layers = flat.layers;
      }
      members = selected.map((m) => ({ name: path.basename(m.dir), pkgName: m.name, dir: m.dir }));
      source = `layers:${file}`;
    } else if (opts.fromCatalog) {
      const t = componentsTarget(config, opts);
      const comps = await discoverComponents(t.dir, { maxDepth: t.maxDepth });
      members = membersFromComponents(comps);
      source = `catalog:${config.activeDomain}`;
    } else {
      const t = componentsTarget(config, opts);
      const comps = await discoverAndSelect({ dir: t.dir, maxDepth: t.maxDepth });
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
    logger.info(chalk.dim(`来源: ${source}`));
    logger.info(chalk.dim(`使用: sjn <命令> --vs ${name}   或  sjn vs link ${name} --into <dir>`));
    return;
  }
  logger.error(`未知操作: ${action}。可用: list / show / create / rm / link`);
  process.exitCode = 1;
}

/**
 * AI 接入配置：show / set-key / set-base / set-model。
 * apiKey 展示时打码。
 */
function handleAiConfig(action: string | undefined, value: string | undefined): void {
  const act = (action ?? 'show').toLowerCase();
  if (act === 'show') {
    const cfg = getAiConfig();
    logger.title('AI 接入配置');
    logger.info(`  baseURL     : ${chalk.cyan(cfg.baseURL)}`);
    logger.info(`  model       : ${chalk.cyan(cfg.model)}`);
    logger.info(`  temperature : ${chalk.cyan(String(cfg.temperature))}`);
    logger.info(`  apiKey      : ${cfg.apiKey ? chalk.green(maskApiKey(cfg.apiKey)) : chalk.red('(未设置)')}`);
    logger.info(chalk.dim(`\n配置文件: ${aiStateFilePath()}`));
    if (!cfg.apiKey) {
      logger.warn('尚未设置 apiKey：sjn ai-config set-key <key>（或设置环境变量 OPENAI_API_KEY）。');
    }
    return;
  }
  if (!value) {
    logger.error(`操作 ${act} 需要一个值。例如: sjn ai-config ${act} <值>`);
    process.exitCode = 1;
    return;
  }
  switch (act) {
    case 'set-key':
      setAiConfig({ apiKey: value });
      logger.success(`已设置 apiKey: ${maskApiKey(value)}`);
      return;
    case 'set-base':
      setAiConfig({ baseURL: value });
      logger.success(`已设置 baseURL: ${value}`);
      return;
    case 'set-model':
      setAiConfig({ model: value });
      logger.success(`已设置 model: ${value}`);
      return;
    default:
      logger.error(`未知操作: ${action}。可用: show / set-key <k> / set-base <url> / set-model <m>`);
      process.exitCode = 1;
  }
}

/**
 * 重建执行上下文：扫描组件库与工程根，从 spec 各步 params.components 反推选中组件。
 * 供 flow show / run / resume 复用（脱离原始交互会话）。
 */
async function buildFlowContext(
  config: SejuaniConfig,
  spec: WorkflowSpec,
  dryRun: boolean,
  yes: boolean
): Promise<StepContext> {
  const compT = resolveScanTarget(config.roots.components);
  const projT = resolveScanTarget(config.roots.projects);
  const components = await discoverComponents(compT.dir, { maxDepth: compT.maxDepth });
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  // 从各步 params.components 的并集反推选中组件；缺省用全部组件兜底
  const names = new Set<string>();
  for (const step of spec.steps) {
    const cs = step.params && (step.params as any).components;
    if (Array.isArray(cs)) for (const n of cs) names.add(String(n));
  }
  const selectedComponents =
    names.size > 0
      ? components.filter((c) => (c.pkgName && names.has(c.pkgName)) || names.has(c.name))
      : components;
  return {
    config,
    components,
    catalog: catalogFromComponents(components),
    projects,
    selectedComponents: selectedComponents.length > 0 ? selectedComponents : components,
    foundProjects: [],
    dryRun,
    yes,
  };
}

/**
 * 工作流模板管理：list / show <name> / rm <name>。
 * （sub 取自 flow 命令的第二个位置参，name 取自第三个）
 */
function handleFlowTemplate(sub: string | undefined, name: string | undefined): void {
  const s = (sub ?? 'list').toLowerCase();
  if (s === 'list' || s === 'ls') {
    const tpls = listTemplates();
    logger.title(`工作流模板（${tpls.length}）`);
    if (tpls.length === 0) {
      logger.info(chalk.dim(`  暂无。用 sjn ai ... --save-template <名> 创建。目录: ${templatesDir()}`));
      return;
    }
    for (const t of tpls) {
      logger.info(`  ${chalk.bold(t.name)}  ${t.title}  ${chalk.dim(`${t.steps.length}步 ${t.savedAt}`)}`);
    }
    logger.info(chalk.dim(`\n目录: ${templatesDir()}`));
    return;
  }
  if (s === 'show') {
    if (!name) {
      logger.error('用法: sjn flow template show <名>');
      process.exitCode = 1;
      return;
    }
    const tpl = loadTemplate(name);
    if (!tpl) {
      logger.error(`模板不存在: ${name}`);
      process.exitCode = 1;
      return;
    }
    logger.title(`模板 ${tpl.name}：${tpl.title}`);
    logger.info(chalk.dim(`保存于: ${tpl.savedAt}，共 ${tpl.steps.length} 步`));
    tpl.steps.forEach((step, i) => {
      const danger = step.dangerous ? chalk.yellow(' [不可逆]') : '';
      const deps = step.dependsOn && step.dependsOn.length ? chalk.dim(`  ← ${step.dependsOn.join(', ')}`) : '';
      logger.info(`  ${chalk.bold(`${i + 1}. ${step.title}`)} ${chalk.dim(`(${step.kind})`)}${danger}${deps}`);
    });
    return;
  }
  if (s === 'rm' || s === 'remove' || s === 'del') {
    if (!name) {
      logger.error('用法: sjn flow template rm <名>');
      process.exitCode = 1;
      return;
    }
    if (removeTemplate(name)) logger.success(`已删除模板 ${chalk.bold(name)}`);
    else logger.warn(`模板不存在: ${name}`);
    return;
  }
  logger.error(`未知操作: ${sub}。可用: list / show <名> / rm <名>`);
  process.exitCode = 1;
}

/**
 * 管理已保存工作流：list / show <id> / run <id> / resume <id> / template / log <id>。
 */
async function handleFlow(
  action: string | undefined,
  id: string | undefined,
  arg: string | undefined,
  opts: { dryRun?: boolean; yes?: boolean },
  config: SejuaniConfig
): Promise<void> {
  const act = (action ?? 'list').toLowerCase();
  if (act === 'list') {
    const specs = listSpecs();
    logger.title(`已保存工作流（${specs.length}）`);
    if (specs.length === 0) {
      logger.info(chalk.dim(`  暂无。目录: ${workflowsDir()}`));
      return;
    }
    for (const s of specs) {
      logger.info(
        `  ${chalk.bold(s.id)}  ${s.title}  ${chalk.dim(`[${s.domain}] ${s.steps.length}步 ${s.createdAt}`)}`
      );
    }
    logger.info(chalk.dim(`\n目录: ${workflowsDir()}`));
    return;
  }

  // 模板管理：flow template [list|show <name>|rm <name>]
  if (act === 'template' || act === 'templates' || act === 'tpl') {
    handleFlowTemplate(id, arg);
    return;
  }

  // 运行日志：flow log <id>
  if (act === 'log' || act === 'logs') {
    if (!id) {
      logger.error('用法: sjn flow log <id>（用 sjn flow list 查看 id）');
      process.exitCode = 1;
      return;
    }
    const file = runLogFile(id);
    logger.title(`工作流运行日志 ${id}`);
    logger.info(chalk.dim(`文件: ${file}`));
    const lines = tailRunLog(id, 60);
    if (lines.length === 0) {
      logger.warn('无日志（该工作流尚未执行过，或日志已清理）。');
      return;
    }
    for (const line of lines) logger.info('  ' + chalk.dim(line));
    return;
  }

  if (!id) {
    logger.error(`操作 ${act} 需要工作流 id。例如: sjn flow ${act} <id>（用 sjn flow list 查看）`);
    process.exitCode = 1;
    return;
  }
  const spec = loadSpec(id);
  if (!spec) {
    logger.error(`未找到工作流: ${id}。用 sjn flow list 查看已保存的工作流。`);
    process.exitCode = 1;
    return;
  }

  switch (act) {
    case 'show': {
      const ctx = await buildFlowContext(config, spec, true, !!opts.yes);
      renderWorkflow(spec, ctx);
      return;
    }
    case 'run': {
      const ctx = await buildFlowContext(config, spec, !!opts.dryRun, !!opts.yes);
      await runWorkflow(spec, ctx, { dryRun: !!opts.dryRun, yes: !!opts.yes, resume: false });
      return;
    }
    case 'resume': {
      const ctx = await buildFlowContext(config, spec, false, !!opts.yes);
      await runWorkflow(spec, ctx, { dryRun: false, yes: !!opts.yes, resume: true });
      return;
    }
    default:
      logger.error(`未知操作: ${action}。可用: list / show <id> / run <id> / resume <id>`);
      process.exitCode = 1;
  }
}

function printGuide(): void {
  const g = `
${chalk.bold.cyan('Sejuani (sjn) · 使用手册')}
批量管理前端工程 / 组件的 package.json、yarn.lock，并提供仓同步与依赖治理。

${chalk.bold('■ 配置标准（替代 rh.toml）')}
  就近查找 sejuani.config.json（cwd 向上），或用 --config <file> 指定；无则用内置默认。
  结构:
    {
      "registries": { "pack": "<拉取源>", "publish": "<发布目标>" },
      "roots": {
        "projects":   { "root": "<工程根>",   "packagesDir": "workspace", "depth": 1 },
        "components": { "root": "<组件库根>", "packagesDir": "workspace", "depth": 1 }
      }
    }
  约定：若 <root>/<packagesDir> 存在则扫描它并用 depth，否则直接扫描 <root>。

${chalk.bold('■ 预设路径 / 目录覆盖')}
  各命令支持 --config、--dir、--projects <dir>、--components <dir>；未指定则回退配置/内置默认。
  交互式向导可在「工程 / 组件库 / 手动输入」间选择扫描范围。

${chalk.bold('■ 安全模式')}
  所有写操作（replace-url / set-version / set-name / upgrade）走「预览 → 确认 → .bak 备份 → 写入」。
  --dry-run 仅预览；-y 跳过确认；--no-backup 不备份；--diff 显示逐行 diff。

${chalk.bold('■ 批量编辑命令')}
  replace-url  批量替换 yarn.lock 中 resolved 的 URL 片段（-f/--from, -t/--to）
  set-version  批量改 package.json version（-b bump 或 -t 指定值，保留 -后缀）
  set-name     批量改 package.json name（--find/--replace 或 -t 固定值）
  link         把选定组件以软链聚合到虚拟空间（-i/--into）
  sync         仓同步：npm pack → npm publish → 清理 tgz（--pack-registry/--publish-registry）
  upgrade      按组件库 catalog 精确版本升级工程内组件依赖（不改 yarn.lock）

${chalk.bold('■ 依赖治理 / 查询命令（只读）')}
  registries          枚举 yarn.lock 中的所有仓库（--by-component 展开组件）
  check-deps          校验依赖 URL 是否可访问（--concurrency/--timeout/--only-missing）
  catalog             列出组件库下每个组件名称+版本（--json [file] 打印或导出文件；--vs 限定集合）
  who-uses <组件>     查询某组件被哪些工程使用
  project-deps <工程> 查询某工程用了哪些组件（含可升级标记）
  usage               全工程组件用量统计 + 未使用组件清单（--json）
  deps-tree [dir]     分析组件间依赖并拓扑分层（layer-0→x）
                      --json [file] 导出按层 JSON；--save <名> 存为虚拟空间；--vs <名> 只分析该集合

${chalk.bold('■ 虚拟空间(vs) — 命名组件集合')}
  虚拟空间是一个命名的组件集合（持久化到 ~/.sejuani/state.json），
  可替代“写死的域组件仓”作为操作目标：任何组件命令加 --vs <名> 即可。
  vs                        查看全部虚拟空间
  vs show <名>             查看详情（含分层）
  vs create <名>           新建：--from-layers <file>[--layers 0,1] / --from-catalog / 交互多选
  vs rm <名>               删除
  vs link <名> --into <dir> 把成员物化为软链目录（等价 link --vs）
  示例: sjn deps-tree --save core  →  sjn set-version --vs core -b patch  →  sjn vs link core --into ./.space

${chalk.bold('■ 常见组合')}
  1) 查看组件库有哪些组件及版本:        sjn catalog
  2) 看某组件谁在用:                    sjn who-uses @f6p/xxx
  3) 升级所有工程组件到最新精确版本:    sjn upgrade --dry-run --diff  →  sjn upgrade -y
  4) 换源前先排查仓库与可用性:          sjn registries && sjn check-deps --only-missing
  5) 组件发布到 nexus:                  sjn sync --dry-run  →  sjn sync -y

${chalk.bold('■ AI 工作流(ai/flow) — 自然语言驱动的可审阅编排')}
  选组件 + 用一句话描述意图 → AI 生成结构化工作流 → 终端审阅 → 确认后按依赖顺序确定性执行。
  规划前会先用确定性影响域引擎算出「受影响工程 + 上游波及组件 + 建议发布层序」并展示（范围不由 AI 臆造）。
  覆盖：组件升级/发包/同步、使用方工程升级/装依赖/分支拉取合并；不可逆步骤(发布/合并/push)在确认时高亮。
  ai-config show|set-key <k>|set-base <url>|set-model <m>   配置 AI 接入（兼容 OpenAI，可环境变量 OPENAI_API_KEY）
  ai [描述...]        选组件→描述→生成并审阅工作流（--dry-run 仅预览，-y 跳过确认）
  ai ... --save-template <名>   把本次生成的工作流存为模板
  ai --template <名>            纯套用模板（不调 AI），按当前选中组件重绑定
  flow list|show <id>|run <id>|resume <id>                 管理/续跑已保存的工作流
  flow template [list|show <名>|rm <名>]                    管理工作流模板
  flow log <id>                                            查看某次运行的 NDJSON 日志（含 AI 请求/响应原文）
  logs                                                     打印日志目录位置

${chalk.dim('提示：升级后需在各工程重新执行 yarn install 以同步 yarn.lock。')}
`;
  logger.info(g);
}

// 先展开自定义短链（若首个参数命中且非内置命令），再交给 commander 解析
const reservedCommands = new Set(program.commands.map((c) => c.name()));
const expandedArgs = expandAlias(process.argv.slice(2), reservedCommands);
program
  .parseAsync([process.argv[0], process.argv[1], ...expandedArgs])
  .then(() => {
    // 部分子命令（如 release/sync）以 inherit 方式跑 npm pack/publish，
    // 子进程会共享父进程的 TTY stdin；退出后该 stdin 句柄仍被引用，
    // 使事件循环无法自然排空导致命令跑完不退出。这里显式退出（保留已设置的 exitCode）。
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
