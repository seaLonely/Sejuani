import { Router, sendJson, sendError } from '../http';
import { SejuaniConfig } from '../../core/config';
import { scanComponents } from '../../core/discover';
import { catalogFromComponents } from '../../core/catalog';
import { buildVersionChanges, buildUpgradeChanges, buildReplaceUrlChanges } from '../../core/operations';
import { keepChanged, applyChanges } from '../../core/runner';
import { BumpType } from '../../core/version';

/**
 * 批量操作路由（先预览 dryRun=true，再执行 dryRun=false）：
 * - POST /api/batch/set-version   批量版本修改
 * - POST /api/batch/upgrade       依赖升级
 * - POST /api/batch/replace-url   URL 替换
 *
 * 写盘统一复用 core/runner 的 applyChanges（始终备份）；
 * handler 内不再包 try/catch，异常由 Router.dispatch 统一转 500。
 */

export function registerBatchRoutes(router: Router, config: SejuaniConfig): void {
  // POST /api/batch/set-version
  router.post('/api/batch/set-version', async (r) => {
    const { bump, to, dryRun } = r.body ?? {};
    if (!bump && !to) {
      sendError(r.res, 400, '需要 bump (patch/minor/major) 或 to (目标版本)');
      return;
    }
    const components = await scanComponents(config, 'components');
    const opts = to
      ? { mode: 'set' as const, target: String(to) }
      : { mode: 'bump' as const, bump: (bump as BumpType) };
    const raw = buildVersionChanges(components, opts);
    const changes = keepChanged(raw);
    const preview = changes.map((c) => ({
      name: c.component.name,
      before: c.files[0]?.before?.match(/"version":\s*"([^"]+)"/)?.[1] ?? '',
      after: c.files[0]?.after?.match(/"version":\s*"([^"]+)"/)?.[1] ?? '',
    }));

    if (dryRun !== false) {
      sendJson(r.res, 200, { changes: preview, applied: false });
      return;
    }
    applyChanges(changes, true);
    sendJson(r.res, 200, { changes: preview, applied: true });
  });

  // POST /api/batch/upgrade
  router.post('/api/batch/upgrade', async (r) => {
    const { only, dryRun } = r.body ?? {};
    const components = await scanComponents(config, 'components');
    const projects = await scanComponents(config, 'projects');
    const catalog = catalogFromComponents(components);
    const raw = buildUpgradeChanges(projects, catalog, {
      only: Array.isArray(only) ? only.map(String) : undefined,
    });
    const changes = keepChanged(raw);
    const preview = changes.map((c) => ({
      project: c.component.name,
      deps: c.files
        .map((f) => f.summary)
        .filter(Boolean)
        .join('; '),
      hits: c.files.reduce((s, f) => s + f.hits, 0),
    }));

    if (dryRun !== false) {
      sendJson(r.res, 200, { changes: preview, applied: false });
      return;
    }
    applyChanges(changes, true);
    sendJson(r.res, 200, { changes: preview, applied: true });
  });

  // POST /api/batch/replace-url
  router.post('/api/batch/replace-url', async (r) => {
    const { from, to, dryRun } = r.body ?? {};
    if (!from || !to) {
      sendError(r.res, 400, '需要 from 和 to 参数');
      return;
    }
    const components = await scanComponents(config, 'components');
    const raw = buildReplaceUrlChanges(components, String(from), String(to));
    const changes = keepChanged(raw);
    const preview = changes.map((c) => ({
      name: c.component.name,
      hits: c.files.reduce((s, f) => s + f.hits, 0),
    }));

    if (dryRun !== false) {
      sendJson(r.res, 200, { changes: preview, applied: false });
      return;
    }
    applyChanges(changes, true);
    sendJson(r.res, 200, { changes: preview, applied: true });
  });
}
