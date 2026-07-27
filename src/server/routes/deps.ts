import { Router, sendJson, sendError } from '../http';
import { SejuaniConfig } from '../../core/config';
import { resolveScanTarget } from '../../core/config';
import { discoverComponents, scanComponents } from '../../core/discover';
import { catalogFromComponents, Catalog } from '../../core/catalog';
import { findProjectsUsing, listComponentsOfProject, summarizeUsage } from '../../core/usage';
import { analyzeLayers, toLayersJson } from '../../core/depsTree';
import { Component } from '../../core/types';

/**
 * 依赖数据看板路由（全部只读，复用 core 的扫描/分析能力）：
 * - GET /api/catalog        组件库清单 [{ name, version, dir }]
 * - GET /api/usage          全工程组件用量 { used, unused }
 * - GET /api/who-uses       ?name= 哪些工程使用了某组件
 * - GET /api/project-deps   ?name= 某工程使用了哪些组件（含 outdated 判断）
 * - GET /api/deps-tree      组件间依赖拓扑分层（toLayersJson 结构）
 */

/** 扫描组件库并构建 catalog（name -> version/dir） */
async function scanCatalog(config: SejuaniConfig): Promise<{ components: Component[]; catalog: Catalog }> {
  const components = await scanComponents(config, 'components');
  return { components, catalog: catalogFromComponents(components) };
}

export function registerDepsRoutes(router: Router, config: SejuaniConfig): void {
  // 组件库清单
  router.get('/api/catalog', async (r) => {
    const { catalog } = await scanCatalog(config);
    const items = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
    sendJson(r.res, 200, items);
  });

  // 全工程组件用量统计
  router.get('/api/usage', async (r) => {
    const [{ catalog }, projects] = await Promise.all([scanCatalog(config), scanComponents(config, 'projects')]);
    sendJson(r.res, 200, summarizeUsage(projects, catalog));
  });

  // 哪些工程使用了某组件
  router.get('/api/who-uses', async (r) => {
    const name = r.query.get('name') ?? '';
    if (!name.trim()) {
      sendError(r.res, 400, '缺少查询参数 name');
      return;
    }
    const projects = await scanComponents(config, 'projects');
    sendJson(r.res, 200, findProjectsUsing(name.trim(), projects));
  });

  // 某工程使用了哪些组件
  router.get('/api/project-deps', async (r) => {
    const name = r.query.get('name') ?? '';
    if (!name.trim()) {
      sendError(r.res, 400, '缺少查询参数 name');
      return;
    }
    const [{ catalog }, projects] = await Promise.all([scanCatalog(config), scanComponents(config, 'projects')]);
    const { project, uses } = listComponentsOfProject(name.trim(), projects, catalog);
    if (!project) {
      sendError(r.res, 404, `未找到工程: ${name}`);
      return;
    }
    sendJson(r.res, 200, uses);
  });

  // 组件间依赖拓扑分层
  router.get('/api/deps-tree', async (r) => {
    const t = resolveScanTarget(config.roots.components);
    const components = await discoverComponents(t.dir, { maxDepth: t.maxDepth });
    sendJson(r.res, 200, toLayersJson(analyzeLayers(components, t.dir)));
  });
}
