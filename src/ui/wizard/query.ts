import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { chalk, logger } from '../../utils/logger';
import { SejuaniConfig } from '../../core/config';
import { resolveScanTarget } from '../../core/config';
import { discoverComponents } from '../../core/discover';
import { buildCatalog, catalogToJson, printCatalog } from '../../core/catalog';
import {
  printProjectsUsing,
  printComponentsOfProject,
  printUsageSummary,
} from '../../core/usage';

export async function flowCatalog(config: SejuaniConfig): Promise<void> {
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

export async function flowWhoUses(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  const { name } = await inquirer.prompt<{ name: string }>([
    { type: 'input', name: 'name', message: '组件包名(如 @f6p/xxx):', filter: (v: string) => v.trim() },
  ]);
  printProjectsUsing(name, projects, catalog);
}

export async function flowProjectDeps(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  const { name } = await inquirer.prompt<{ name: string }>([
    { type: 'input', name: 'name', message: '工程名(目录名或 package name):', filter: (v: string) => v.trim() },
  ]);
  printComponentsOfProject(name, projects, catalog);
}

export async function flowUsage(config: SejuaniConfig): Promise<void> {
  const projT = resolveScanTarget(config.roots.projects);
  const compT = resolveScanTarget(config.roots.components);
  const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
  const catalog = await buildCatalog(compT.dir, compT.maxDepth);
  printUsageSummary(projects, catalog, false);
}
