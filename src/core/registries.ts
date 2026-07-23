import { Component } from '../types';
import { readYarnLock } from './lockParser';
import { chalk, logger } from '../utils/logger';

export interface RegistryStat {
  base: string;
  /** 命中的 resolved 条目数 */
  hits: number;
  /** 涉及的组件集合 */
  components: Set<string>;
}

/** 从 resolved URL + 包名求 registry base */
export function registryBaseOf(url: string, pkgName: string): string {
  const marker = `/${pkgName}/-/`;
  const idx = url.indexOf(marker);
  if (idx > 0) return url.slice(0, idx);
  // 回退：protocol//host
  const m = /^([a-z]+:\/\/[^/]+)/i.exec(url);
  return m ? m[1] : url;
}

/**
 * 枚举所选组件 yarn.lock 中出现的所有 registry base。
 */
export function collectRegistries(components: Component[]): RegistryStat[] {
  const map = new Map<string, RegistryStat>();
  for (const c of components) {
    if (!c.yarnLockPath) continue;
    let entries;
    try {
      entries = readYarnLock(c.yarnLockPath);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.resolved) continue;
      const base = registryBaseOf(e.resolved, e.name);
      let stat = map.get(base);
      if (!stat) {
        stat = { base, hits: 0, components: new Set() };
        map.set(base, stat);
      }
      stat.hits += 1;
      stat.components.add(c.name);
    }
  }
  return [...map.values()].sort((a, b) => b.hits - a.hits);
}

/** 打印结果 */
export function printRegistries(components: Component[], byComponent: boolean): void {
  const stats = collectRegistries(components);
  logger.title('yarn.lock 中的仓库枚举');
  if (stats.length === 0) {
    logger.warn('未在所选组件中发现 resolved URL。');
    return;
  }
  for (const s of stats) {
    logger.info(
      `  ${chalk.cyan(s.base)}  ${chalk.dim(`命中 ${s.hits} 处 / ${s.components.size} 个组件`)}`
    );
    if (byComponent) {
      for (const name of [...s.components].sort()) {
        logger.info('      ' + chalk.dim(name));
      }
    }
  }
}
