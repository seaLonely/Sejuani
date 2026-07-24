import path from 'path';
import { Component } from '../types';
import { chalk, logger } from '../utils/logger';
import { SejuaniConfig } from '../config';
import { resolveScanTarget } from '../core/configLoader';
import { discoverComponents } from '../core/discover';
import { resolveVsComponents } from '../core/vsStore';
import { ScanTarget } from '../ui/select';

/**
 * 依据 CLI 选项与配置解析出一个扫描目标。
 * 优先级：--dir > --projects > --components > 配置/内置默认（defaultKind）。
 * 三个 scope 选项都会生效：显式给出哪个就扫哪个，均未给出时回退默认根。
 */
export function pickScanTarget(
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
export function projectsTarget(config: SejuaniConfig, opts: { projects?: string }): ScanTarget {
  return opts.projects ? { dir: path.resolve(opts.projects) } : resolveScanTarget(config.roots.projects);
}

/** 解析 components 根扫描目标（供需要 catalog 的命令使用）。 */
export function componentsTarget(config: SejuaniConfig, opts: { components?: string }): ScanTarget {
  return opts.components ? { dir: path.resolve(opts.components) } : resolveScanTarget(config.roots.components);
}

/**
 * 统一的组件解析：若传入 --vs 则读虚拟空间成员，否则按扫描目标发现。
 * 虚拟空间不存在时抛错。requireYarnLock 时会过滤无 yarn.lock 的成员。
 */
export async function resolveComponents(
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

// 从 package.json 动态读取版本，避免硬编码与实际发布版本不一致
export function readPkgVersion(): string {
  try {
    // dist/index.js 与 src/index.ts 均位于包根的一级子目录，package.json 在上层
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
