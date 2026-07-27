import { Capability, AgentTool, AgentContext, ToolResult } from '../types';
import { resolveScanTarget } from '../../config';
import { discoverComponents } from '../../discover';
import { catalogFromComponents } from '../../catalog';
import { findProjectsUsing, listComponentsOfProject } from '../../usage';
import { analyzeLayers } from '../../depsTree';

/**
 * 仓库管理能力模块：扫描组件/工程、查询 catalog、依赖分析。
 */

const reposDiscover: AgentTool = {
  name: 'repos_discover',
  readOnly: true,
  description: '扫描并展示当前域的组件库或工程仓库列表（名称、版本、路径）',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['components', 'projects'], description: '扫描类型：components=组件库, projects=工程仓库' },
    },
    required: ['type'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const rootCfg = args.type === 'projects' ? ctx.config.roots.projects : ctx.config.roots.components;
    const target = resolveScanTarget(rootCfg);
    const items = await discoverComponents(target.dir, { maxDepth: target.maxDepth });
    const label = args.type === 'projects' ? '工程' : '组件';
    const lines = items.map((c) => `${c.pkgName ?? c.name} @ ${c.pkgVersion ?? '?'}`);
    return {
      success: true,
      output: `${label}库（${items.length} 个）：\n${lines.join('\n')}`,
      data: items.map((c) => ({ name: c.pkgName ?? c.name, version: c.pkgVersion, dir: c.dir })),
    };
  },
};

const reposCatalog: AgentTool = {
  name: 'repos_catalog',
  readOnly: true,
  description: '列出组件 catalog（所有组件的名称和当前版本），可按关键词过滤',
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: '可选，按名称过滤的关键词' },
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveScanTarget(ctx.config.roots.components);
    const items = await discoverComponents(target.dir, { maxDepth: target.maxDepth });
    let entries = items.map((c) => ({ name: c.pkgName ?? c.name, version: c.pkgVersion ?? '?' }));
    if (args.filter) {
      const kw = String(args.filter).toLowerCase();
      entries = entries.filter((e) => e.name.toLowerCase().includes(kw));
    }
    const lines = entries.map((e) => `${e.name} @ ${e.version}`);
    return { success: true, output: `组件 catalog（${entries.length} 个）：\n${lines.join('\n')}` };
  },
};

const reposWhoUses: AgentTool = {
  name: 'repos_who_uses',
  readOnly: true,
  description: '查询哪些工程项目使用了指定的组件（反向依赖查询）',
  parameters: {
    type: 'object',
    properties: {
      componentName: { type: 'string', description: '组件的 npm 包名' },
    },
    required: ['componentName'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const projTarget = resolveScanTarget(ctx.config.roots.projects);
    const projects = await discoverComponents(projTarget.dir, { maxDepth: projTarget.maxDepth });
    const hits = findProjectsUsing(String(args.componentName), projects);
    if (hits.length === 0) {
      return { success: true, output: `没有工程使用组件 ${args.componentName}。` };
    }
    const lines = hits.map((h) => `${h.project}: ${h.range}`);
    return { success: true, output: `使用 ${args.componentName} 的工程（${hits.length}）：\n${lines.join('\n')}` };
  },
};

const repsDepsTree: AgentTool = {
  name: 'repos_deps_tree',
  readOnly: true,
  description: '展示组件库的依赖分层（layer-0 为最底层无依赖组件，层级递增）',
  parameters: { type: 'object', properties: {} },
  async execute(args, ctx): Promise<ToolResult> {
    const target = resolveScanTarget(ctx.config.roots.components);
    const components = await discoverComponents(target.dir, { maxDepth: target.maxDepth });
    const { layers } = analyzeLayers(components, ctx.domain);
    const lines: string[] = [];
    layers.forEach((layer, i) => {
      lines.push(`layer-${i}（${layer.length}）: ${layer.map((c) => c.name).join(', ')}`);
    });
    return { success: true, output: `组件依赖分层（${layers.length} 层）：\n${lines.join('\n')}` };
  },
};

const reposProjectDeps: AgentTool = {
  name: 'repos_project_deps',
  readOnly: true,
  description: '展示某个工程项目依赖了哪些内部组件及其版本',
  parameters: {
    type: 'object',
    properties: {
      projectName: { type: 'string', description: '工程名称或 npm 包名' },
    },
    required: ['projectName'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const projTarget = resolveScanTarget(ctx.config.roots.projects);
    const projects = await discoverComponents(projTarget.dir, { maxDepth: projTarget.maxDepth });
    const compTarget = resolveScanTarget(ctx.config.roots.components);
    const components = await discoverComponents(compTarget.dir, { maxDepth: compTarget.maxDepth });
    const catalog = catalogFromComponents(components);
    const proj = projects.find((p) => p.pkgName === args.projectName || p.name === args.projectName);
    if (!proj) {
      return { success: false, output: `未找到工程: ${args.projectName}` };
    }
    const { uses } = listComponentsOfProject(String(args.projectName), projects, catalog);
    if (uses.length === 0) {
      return { success: true, output: `工程 ${args.projectName} 未使用任何内部组件。` };
    }
    const lines = uses.map((d) => `${d.name}: ${d.range} → catalog ${d.catalogVersion}`);
    return { success: true, output: `工程 ${args.projectName} 的内部组件依赖（${uses.length}）：\n${lines.join('\n')}` };
  },
};

export const reposCapability: Capability = {
  name: 'repos',
  description: '组件/工程仓库管理：扫描、catalog 查询、依赖分析、反向查询',
  tools: [reposDiscover, reposCatalog, reposWhoUses, repsDepsTree, reposProjectDeps],
};
