import { Component } from '../types';
import { Catalog } from './catalog';
import { readProjectDeps } from './projectDeps';
import { chalk, logger } from '../utils/logger';

/** Feature 1: 组件名 → 哪些工程用了它 */
export function findProjectsUsing(
  componentName: string,
  projects: Component[]
): { project: string; range: string; section: string }[] {
  const hits: { project: string; range: string; section: string }[] = [];
  for (const p of projects) {
    // 同一组件可能同时出现在 dependencies 与 devDependencies，按工程去重只报一次
    let picked: { project: string; range: string; section: string } | null = null;
    for (const d of readProjectDeps(p)) {
      if (d.name === componentName) {
        picked = { project: p.name, range: d.range, section: d.section };
        if (d.section === 'dependencies') break; // dependencies 优先展示
      }
    }
    if (picked) hits.push(picked);
  }
  return hits;
}

export function printProjectsUsing(
  componentName: string,
  projects: Component[],
  catalog?: Catalog
): void {
  logger.section(`哪些工程使用了 ${componentName}`);
  if (catalog && !catalog.has(componentName)) {
    logger.warn(`注意：${componentName} 不在组件库 catalog 中，可能非本组织组件。`);
  }
  const hits = findProjectsUsing(componentName, projects);
  if (hits.length === 0) {
    logger.warn('没有工程使用该组件。');
    return;
  }
  logger.table(
    ['工程', '声明区间'],
    hits.map((h) => [chalk.cyan(h.project), chalk.dim(`${h.range} (${h.section})`)])
  );
  logger.success(`共 ${hits.length} 个工程使用。`);
}

/** Feature 2: 工程名 → 用了哪些组件（catalog 交集） */
export interface ProjectComponentUse {
  name: string;
  range: string;
  section: string;
  catalogVersion: string;
  /** 声明区间是否已包含 catalog 版本（简单判断是否落后） */
  outdated: boolean;
}

function rangeSatisfiesExact(range: string, version: string): boolean {
  // 简单判断：去掉 ^/~/>=/<= 等前缀后与 version 精确相等即视为“已是该版本”
  const cleaned = range.replace(/^[\^~>=<\s]+/, '').trim();
  return cleaned === version;
}

export function listComponentsOfProject(
  projectName: string,
  projects: Component[],
  catalog: Catalog
): { project: Component | null; uses: ProjectComponentUse[] } {
  const project = projects.find((p) => p.name === projectName || p.pkgName === projectName) ?? null;
  if (!project) return { project: null, uses: [] };
  const uses: ProjectComponentUse[] = [];
  for (const d of readProjectDeps(project)) {
    const item = catalog.get(d.name);
    if (!item) continue;
    uses.push({
      name: d.name,
      range: d.range,
      section: d.section,
      catalogVersion: item.version,
      outdated: !rangeSatisfiesExact(d.range, item.version),
    });
  }
  return { project, uses };
}

export function printComponentsOfProject(
  projectName: string,
  projects: Component[],
  catalog: Catalog
): void {
  logger.section(`工程 ${projectName} 使用的组件`);
  const { project, uses } = listComponentsOfProject(projectName, projects, catalog);
  if (!project) {
    logger.error(`未找到工程: ${projectName}`);
    return;
  }
  if (uses.length === 0) {
    logger.warn('该工程未使用组件库中的任何组件。');
    return;
  }
  logger.table(
    ['组件', '声明区间', '状态'],
    uses.map((u) => [
      chalk.cyan(u.name),
      chalk.dim(`${u.range} (${u.section})`),
      u.outdated ? chalk.yellow(`↑ 可升级到 ${u.catalogVersion}`) : chalk.green('已最新'),
    ])
  );
  logger.success(`共 ${uses.length} 个组件。`);
}

/** Feature 3: 全工程组件用量统计 */
export interface UsageSummaryItem {
  name: string;
  count: number;
  projects: string[];
  ranges: string[];
  catalogVersion: string;
}

export function summarizeUsage(
  projects: Component[],
  catalog: Catalog
): { used: UsageSummaryItem[]; unused: string[] } {
  const map = new Map<string, UsageSummaryItem>();
  for (const p of projects) {
    const seenInProject = new Set<string>();
    for (const d of readProjectDeps(p)) {
      const item = catalog.get(d.name);
      if (!item) continue;
      let agg = map.get(d.name);
      if (!agg) {
        agg = { name: d.name, count: 0, projects: [], ranges: [], catalogVersion: item.version };
        map.set(d.name, agg);
      }
      if (!seenInProject.has(d.name)) {
        agg.count += 1;
        agg.projects.push(p.name);
        seenInProject.add(d.name);
      }
      if (!agg.ranges.includes(d.range)) agg.ranges.push(d.range);
    }
  }
  const used = [...map.values()].sort((a, b) => b.count - a.count);
  const unused = [...catalog.keys()].filter((name) => !map.has(name)).sort();
  return { used, unused };
}

export function printUsageSummary(
  projects: Component[],
  catalog: Catalog,
  asJson: boolean
): void {
  const { used, unused } = summarizeUsage(projects, catalog);
  if (asJson) {
    logger.info(JSON.stringify({ used, unused }, null, 2));
    return;
  }
  logger.section('全工程组件用量统计');
  if (used.length === 0) {
    logger.warn('未发现任何工程使用组件库中的组件。');
  }
  logger.table(
    ['组件', '用量'],
    used.map((u) => [
      chalk.cyan(u.name),
      chalk.dim(`被 ${u.count} 个工程使用 | catalog ${u.catalogVersion} | 区间 ${u.ranges.join(', ')}`),
    ])
  );
  if (unused.length > 0) {
    logger.section('未被任何工程使用的组件');
    for (const name of unused) {
      logger.item(chalk.dim(name));
    }
  }
  logger.success(`使用中 ${used.length} 个 / 未使用 ${unused.length} 个。`);
}
