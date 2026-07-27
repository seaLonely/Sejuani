import path from 'path';
import { Component } from './types';
import { readProjectDeps } from './projectDeps';
import { chalk, logger } from '../utils/logger';

/** 分层后的单个组件条目 */
export interface LayerComponent {
  /** package.json 的 name（组件在 catalog 中的唯一标识） */
  name: string;
  /** package.json 的 version */
  version: string;
  /** 组件目录绝对路径 */
  dir: string;
  /** 该组件依赖的、同属组件库的其它组件（pkgName） */
  deps: string[];
}

/** 依赖分层分析结果 */
export interface LayerResult {
  /** 分析所基于的组件库根目录 */
  root: string;
  /** 参与分析的组件总数（有 pkgName 的） */
  totalComponents: number;
  /** 层级数组：layers[i] 即 layer-i 的组件（i 越小越底层，被别人依赖） */
  layers: LayerComponent[][];
  /** 处于依赖环中、或被环阻塞而无法定层的组件 */
  cycles: LayerComponent[];
  /** 组件间依赖邻接表：pkgName -> 其依赖的组件库内组件 pkgName[] */
  edges: Record<string, string[]>;
}

/**
 * 分析组件库内部「组件间依赖」并做拓扑分层。
 * - 只统计依赖中属于本组件库(catalog)的条目，第三方依赖忽略。
 * - 依据 dependencies + devDependencies（与 usage/who-uses 口径一致）。
 * - layer-0 = 不依赖任何组件库内组件的最底层；layer-k = 其所有内部依赖的最大层 + 1。
 * - 存在依赖环时，环内及被环阻塞的组件归入 cycles，不参与分层。
 */
export function analyzeLayers(components: Component[], root: string): LayerResult {
  // 1) 组件库 catalog：pkgName -> Component
  const byPkg = new Map<string, Component>();
  for (const c of components) {
    if (c.pkgName) byPkg.set(c.pkgName, c);
  }

  // 2) 组件间依赖边（仅保留 catalog 内、且非自引用）
  const edges = new Map<string, Set<string>>();
  for (const [pkg, comp] of byPkg) {
    const set = new Set<string>();
    for (const d of readProjectDeps(comp)) {
      if (d.name !== pkg && byPkg.has(d.name)) set.add(d.name);
    }
    edges.set(pkg, set);
  }

  // 3) 最长路径分层（Kahn 变体）：所有依赖都已定层时，本节点 = max(依赖层) + 1
  const layerOf = new Map<string, number>();
  const remaining = new Set(byPkg.keys());
  let progress = true;
  while (progress && remaining.size > 0) {
    progress = false;
    for (const n of [...remaining]) {
      const deps = edges.get(n)!;
      let ready = true;
      let max = -1;
      for (const d of deps) {
        const dl = layerOf.get(d);
        if (dl === undefined) {
          ready = false;
          break;
        }
        if (dl > max) max = dl;
      }
      if (ready) {
        layerOf.set(n, max + 1);
        remaining.delete(n);
        progress = true;
      }
    }
  }

  // 4) 组装结果
  const toEntry = (pkg: string): LayerComponent => {
    const comp = byPkg.get(pkg)!;
    return {
      name: pkg,
      version: comp.pkgVersion ?? '',
      dir: comp.dir,
      deps: [...(edges.get(pkg) ?? [])].sort(),
    };
  };

  const maxLayer = layerOf.size > 0 ? Math.max(...layerOf.values()) : -1;
  const layers: LayerComponent[][] = [];
  for (let i = 0; i <= maxLayer; i++) layers.push([]);
  for (const [pkg, l] of layerOf) layers[l].push(toEntry(pkg));
  for (const layer of layers) layer.sort((a, b) => a.name.localeCompare(b.name));

  const cycles = [...remaining].map(toEntry).sort((a, b) => a.name.localeCompare(b.name));

  const edgesObj: Record<string, string[]> = {};
  for (const [pkg, set] of edges) edgesObj[pkg] = [...set].sort();

  return { root, totalComponents: byPkg.size, layers, cycles, edges: edgesObj };
}

/** 导出为可序列化的 JSON 对象（同时用作 `vs create --from-layers` 的输入） */
export function toLayersJson(result: LayerResult): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    root: result.root,
    totalComponents: result.totalComponents,
    layerCount: result.layers.length,
    layers: result.layers.map((comps, i) => ({
      layer: i,
      components: comps.map((c) => ({
        name: c.name,
        version: c.version,
        dir: c.dir,
        deps: c.deps,
      })),
    })),
    cycles: result.cycles.map((c) => ({
      name: c.name,
      version: c.version,
      dir: c.dir,
      deps: c.deps,
    })),
    edges: result.edges,
  };
}

/** 打印分层结果（人类可读） */
export function printLayers(result: LayerResult): void {
  logger.section('组件依赖分层 (layer-0 → 越上层依赖越多)');
  if (result.totalComponents === 0) {
    logger.warn('组件库中未发现任何带 name 的组件。');
    return;
  }
  result.layers.forEach((comps, i) => {
    logger.info(chalk.bold(`\nlayer-${i}  ${chalk.dim(`(${comps.length})`)}`));
    for (const c of comps) {
      const depNote = c.deps.length > 0 ? chalk.dim(` → ${c.deps.join(', ')}`) : chalk.dim(' (无内部依赖)');
      logger.item(`${chalk.cyan(c.name)}${depNote}`);
    }
  });
  if (result.cycles.length > 0) {
    logger.section('⚠ 依赖环 / 被环阻塞（未分层）');
    for (const c of result.cycles) {
      logger.item(`${chalk.yellow(c.name)}${chalk.dim(c.deps.length ? ` → ${c.deps.join(', ')}` : '')}`);
    }
  }
  logger.success(
    `\n共 ${result.totalComponents} 个组件，${result.layers.length} 层` +
      (result.cycles.length ? `，${result.cycles.length} 个存在环依赖` : '')
  );
}

/** 从磁盘上的 layers JSON 文件解析出「pkgName -> dir」的成员列表（供 vs create 使用） */
export interface FlatLayerMember {
  name: string;
  version: string;
  dir: string;
  layer: number;
}
export function flattenLayersJson(json: unknown): { members: FlatLayerMember[]; layers: string[][] } {
  const obj = json as Record<string, unknown>;
  const members: FlatLayerMember[] = [];
  const layers: string[][] = [];
  const layerArr = Array.isArray(obj.layers) ? (obj.layers as Record<string, unknown>[]) : [];
  for (const entry of layerArr) {
    const idx = typeof entry.layer === 'number' ? entry.layer : layers.length;
    const comps = Array.isArray(entry.components) ? (entry.components as Record<string, unknown>[]) : [];
    const names: string[] = [];
    for (const c of comps) {
      const name = String(c.name ?? '');
      const dir = String(c.dir ?? '');
      if (!name || !dir) continue;
      members.push({ name, version: String(c.version ?? ''), dir: path.resolve(dir), layer: idx });
      names.push(name);
    }
    layers[idx] = names;
  }
  // cycles 也纳入成员（层记为 -1），但不进入 layers 分层
  const cycles = Array.isArray(obj.cycles) ? (obj.cycles as Record<string, unknown>[]) : [];
  for (const c of cycles) {
    const name = String(c.name ?? '');
    const dir = String(c.dir ?? '');
    if (!name || !dir) continue;
    members.push({ name, version: String(c.version ?? ''), dir: path.resolve(dir), layer: -1 });
  }
  return { members, layers: layers.filter(Boolean) };
}
