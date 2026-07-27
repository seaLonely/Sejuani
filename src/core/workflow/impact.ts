import { Component } from '../types';
import { chalk, logger } from '../../utils/logger';
import { findProjectsUsing } from '../usage';
import { analyzeLayers } from '../depsTree';
import { StepContext } from './types';

/**
 * 确定性影响域引擎（只读）。
 *
 * 规划前用 sjn 既有原语把「影响范围」算成事实，再喂给 LLM，让 AI 只负责排步骤、
 * 不负责猜范围：
 * - 直接使用方：findProjectsUsing —— 哪些工程依赖了选中组件。
 * - 上游波及：analyzeLayers.edges 反转 —— 哪些其它组件依赖了选中组件（通常需级联发布）。
 * - 发布层序：analyzeLayers.layers —— 选中+波及组件的底层→上层顺序，供编排参考。
 * - 跨域线索：选中组件在当前域零使用方 → 可能被别的域使用，仅告警不阻断。
 */

export interface ImpactReport {
  /** 选中组件的 pkgName */
  selected: string[];
  /** 受影响工程（按目录去重） */
  affectedProjects: Component[];
  /** 依赖了选中组件的其它组件 pkgName（上游波及，通常需级联 bump/release） */
  dependentComponents: string[];
  /** 选中 + 波及组件的建议发布顺序（底层→上层） */
  releaseOrder: string[];
  /** 在当前域零使用方的选中组件（跨域使用线索） */
  zeroUserComponents: string[];
  /** 是否存在跨域线索（zeroUserComponents 非空） */
  crossDomainHint: boolean;
}

/** 计算影响域报告。 */
export function analyzeImpact(ctx: StepContext): ImpactReport {
  const selected = ctx.selectedComponents
    .map((c) => c.pkgName)
    .filter((n): n is string => !!n);

  // 直接使用方（按工程目录去重），并记录零使用方的组件
  const byDir = new Map<string, Component>();
  const zeroUserComponents: string[] = [];
  for (const name of selected) {
    const hits = findProjectsUsing(name, ctx.projects);
    if (hits.length === 0) zeroUserComponents.push(name);
    for (const h of hits) {
      const proj = ctx.projects.find((p) => p.name === h.project || p.pkgName === h.project);
      if (proj) byDir.set(proj.dir, proj);
    }
  }
  const affectedProjects = [...byDir.values()];

  // 上游波及：edges 为 pkg -> 其依赖的组件；反转成 dep -> 依赖它的组件，再从选中 BFS
  const { edges, layers } = analyzeLayers(ctx.components, ctx.config.activeDomain);
  const dependents = new Map<string, Set<string>>();
  for (const [pkg, deps] of Object.entries(edges)) {
    for (const d of deps) {
      if (!dependents.has(d)) dependents.set(d, new Set());
      dependents.get(d)!.add(pkg);
    }
  }
  const selectedSet = new Set(selected);
  const visited = new Set<string>();
  const queue = [...selected];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const up of dependents.get(cur) ?? []) {
      if (!visited.has(up)) {
        visited.add(up);
        queue.push(up);
      }
    }
  }
  const dependentComponents = [...visited].filter((v) => !selectedSet.has(v));

  // 发布层序：选中 + 波及组件按层级升序（layer 越小越底层，先发）
  const layerOf = new Map<string, number>();
  layers.forEach((layer, i) => layer.forEach((c) => layerOf.set(c.name, i)));
  const releaseOrder = [...new Set([...selected, ...dependentComponents])].sort(
    (a, b) => (layerOf.get(a) ?? Number.MAX_SAFE_INTEGER) - (layerOf.get(b) ?? Number.MAX_SAFE_INTEGER)
  );

  return {
    selected,
    affectedProjects,
    dependentComponents,
    releaseOrder,
    zeroUserComponents,
    crossDomainHint: zeroUserComponents.length > 0,
  };
}

/** 终端打印影响域摘要（规划前展示，帮助用户判断范围）。 */
export function printImpact(report: ImpactReport): void {
  logger.title('影响范围（由 sjn 确定性计算）');
  logger.info(`  选中组件(${report.selected.length})：${report.selected.join(', ') || '(无)'}`);
  logger.info(
    `  受影响工程(${report.affectedProjects.length})：` +
      (report.affectedProjects.length
        ? report.affectedProjects.map((p) => p.pkgName ?? p.name).join(', ')
        : '(无)')
  );
  logger.info(
    `  上游波及组件(${report.dependentComponents.length})：` +
      (report.dependentComponents.length ? report.dependentComponents.join(', ') : '(无)')
  );
  if (report.releaseOrder.length > 0) {
    logger.info(`  建议发布层序（底层→上层）：${report.releaseOrder.join(' → ')}`);
  }
  if (report.crossDomainHint) {
    logger.warn(
      `  跨域线索：以下选中组件在当前域「${chalk.bold('无使用方')}」，可能被其它域工程使用，请人工确认：` +
        report.zeroUserComponents.join(', ')
    );
  }
}
