import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/configLoader';
import { SejuaniConfig } from '../../config';
import { discoverComponents } from '../../core/discover';
import { discoverAndSelect } from '../../ui/select';
import { createVirtualSpace } from '../../core/link';
import { flattenLayersJson } from '../../core/depsTree';
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
} from '../../core/vsStore';
import { componentsTarget } from '../context';

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

/** 虚拟空间(vs) 管理命令。 */
export function register(program: Command): void {
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
}
