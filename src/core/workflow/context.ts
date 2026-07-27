import { SejuaniConfig } from '../config';
import { scanComponents } from '../discover';
import { catalogFromComponents } from '../catalog';
import { RunState, StepContext, WorkflowSpec } from './types';

/**
 * 执行上下文构建：扫描组件库与工程根，从 spec 各步 params.components 反推选中组件。
 * 供 CLI（flow run/resume/show）、server（workflows 路由）与 Agent（会话内直跑）三端共用，
 * 脱离原始交互会话也能重建 StepContext。
 */
export async function buildStepContext(
  config: SejuaniConfig,
  spec?: WorkflowSpec,
  opts: { dryRun?: boolean; yes?: boolean } = {}
): Promise<StepContext> {
  const components = await scanComponents(config, 'components');
  const projects = await scanComponents(config, 'projects');

  // 从各步 params.components 的并集反推选中组件；缺省用全部组件兜底
  const names = new Set<string>();
  for (const step of spec?.steps ?? []) {
    const cs = step.params && (step.params as Record<string, unknown>).components;
    if (Array.isArray(cs)) for (const n of cs) names.add(String(n));
  }
  const selectedComponents =
    names.size > 0
      ? components.filter((c) => (c.pkgName && names.has(c.pkgName)) || names.has(c.name))
      : components;

  return {
    config,
    components,
    catalog: catalogFromComponents(components),
    projects,
    selectedComponents: selectedComponents.length > 0 ? selectedComponents : components,
    foundProjects: [],
    dryRun: !!opts.dryRun,
    yes: !!opts.yes,
  };
}

/**
 * resume 时把已完成步骤的产物（StepResult.outputs）回放到执行上下文：
 * - project.find-users 的 foundProjects → ctx.foundProjects（按 pkgName/目录名匹配）；
 * - git.mr 的 mrUrl/workBranch → ctx.yunxiao（修复跨进程 resume 后 {mrUrl} 渲染为「待生成」的问题）；
 * - 全部 outputs → ctx.runOutputs（供 notify.summary 等汇总步骤消费）。
 */
export function hydrateContext(state: RunState, spec: WorkflowSpec, ctx: StepContext): void {
  const kindById = new Map(spec.steps.map((s) => [s.id, s.kind]));
  for (const r of state.results) {
    if (r.status !== 'ok' || !r.outputs) continue;
    ctx.runOutputs = ctx.runOutputs ?? {};
    ctx.runOutputs[r.id] = r.outputs;
    const kind = kindById.get(r.id);
    if (kind === 'project.find-users' && Array.isArray(r.outputs.foundProjects)) {
      const names = new Set(r.outputs.foundProjects.map(String));
      ctx.foundProjects = ctx.projects.filter(
        (p) => (p.pkgName && names.has(p.pkgName)) || names.has(p.name)
      );
    }
    if (kind === 'git.mr' && ctx.yunxiao) {
      if (typeof r.outputs.mrUrl === 'string' && r.outputs.mrUrl) ctx.yunxiao.mrUrl = r.outputs.mrUrl;
      if (typeof r.outputs.workBranch === 'string' && r.outputs.workBranch) ctx.yunxiao.workBranch = r.outputs.workBranch;
    }
  }
}
