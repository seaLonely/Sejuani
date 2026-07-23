import { discoverComponents } from './discover';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';

export interface CatalogItem {
  /** package.json 的 name */
  name: string;
  /** package.json 的 version */
  version: string;
  /** 组件目录 */
  dir: string;
}

export type Catalog = Map<string, CatalogItem>;

/**
 * 扫描组件库目录，构建「我们自己的组件」清单（name -> {version, dir}）。
 * 这是判定组件 vs 第三方依赖的唯一来源。
 */
export async function buildCatalog(
  componentsDir: string,
  maxDepth?: number
): Promise<Catalog> {
  const comps = await discoverComponents(componentsDir, { maxDepth });
  const catalog: Catalog = new Map();
  for (const c of comps) {
    if (c.pkgName) {
      catalog.set(c.pkgName, {
        name: c.pkgName,
        version: c.pkgVersion ?? '',
        dir: c.dir,
      });
    }
  }
  return catalog;
}

/** 从已发现的组件列表构建 catalog（避免重复扫描） */
export function catalogFromComponents(components: Component[]): Catalog {
  const catalog: Catalog = new Map();
  for (const c of components) {
    if (c.pkgName) {
      catalog.set(c.pkgName, { name: c.pkgName, version: c.pkgVersion ?? '', dir: c.dir });
    }
  }
  return catalog;
}

/** 导出为「名称 + 版本」数组（按 name 排序），供 --json 打印或写文件使用。 */
export function catalogToJson(catalog: Catalog): { name: string; version: string }[] {
  return [...catalog.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => ({ name: i.name, version: i.version }));
}

/** Feature 4: 打印组件库清单（名称 + 版本 + 目录） */
export function printCatalog(catalog: Catalog, asJson: boolean): void {
  const items = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (asJson) {
    logger.info(
      JSON.stringify(
        items.map((i) => ({ name: i.name, version: i.version })),
        null,
        2
      )
    );
    return;
  }
  logger.title('组件库清单');
  if (items.length === 0) {
    logger.warn('组件库中未发现任何组件。');
    return;
  }
  for (const i of items) {
    logger.info(`  ${chalk.cyan(i.name)}  ${chalk.green(i.version || '?')}  ${chalk.dim(i.dir)}`);
  }
  logger.success(`共 ${items.length} 个组件。`);
}
