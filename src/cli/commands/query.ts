import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import { logger } from '../../utils/logger';
import { loadConfig } from '../../core/config';
import { discoverComponents } from '../../core/discover';
import {
  buildCatalog,
  catalogFromComponents,
  catalogToJson,
  printCatalog,
} from '../../core/catalog';
import {
  printProjectsUsing,
  printComponentsOfProject,
  printUsageSummary,
} from '../../core/usage';
import { componentsTarget, projectsTarget, resolveComponents } from '../context';

/** 查询统计类命令（只读）：catalog / who-uses / project-deps / usage。 */
export function register(program: Command): void {
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
}
