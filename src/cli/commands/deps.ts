import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/configLoader';
import { discoverComponents } from '../../core/discover';
import { Component } from '../../types';
import { printRegistries } from '../../core/registries';
import { checkDependencies } from '../../core/depCheck';
import { analyzeLayers, printLayers, toLayersJson } from '../../core/depsTree';
import { saveVirtualSpace, VsMember } from '../../core/vsStore';
import { componentsTarget, resolveComponents } from '../context';

/** 依赖治理类命令（只读/分析）：registries / check-deps / deps-tree。 */
export function register(program: Command): void {
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
}
