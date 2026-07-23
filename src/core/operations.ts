import { Component, ComponentChange, FileChange } from '../types';
import { editName, editVersion, editDependencies } from './packageJson';
import { editYarnLockUrl } from './yarnLock';
import { BumpType } from './version';
import { Catalog } from './catalog';

/** 替换 yarn.lock 中 resolved URL */
export function buildReplaceUrlChanges(
  components: Component[],
  from: string,
  to: string
): ComponentChange[] {
  const result: ComponentChange[] = [];
  for (const c of components) {
    if (!c.yarnLockPath) continue;
    const edit = editYarnLockUrl(c.yarnLockPath, from, to);
    const files: FileChange[] = [
      {
        filePath: c.yarnLockPath,
        before: edit.before,
        after: edit.after,
        hits: edit.hits,
        summary: edit.summary,
      },
    ];
    result.push({ component: c, files });
  }
  return result;
}

/** 修改 package.json version（bump 或 set） */
export function buildVersionChanges(
  components: Component[],
  opts:
    | { mode: 'bump'; bump: BumpType }
    | { mode: 'set'; target: string; keepSuffix?: boolean }
): ComponentChange[] {
  const result: ComponentChange[] = [];
  for (const c of components) {
    const edit = editVersion(c.packageJsonPath, opts);
    result.push({
      component: c,
      files: [
        {
          filePath: c.packageJsonPath,
          before: edit.before,
          after: edit.after,
          hits: edit.changed ? 1 : 0,
          summary: edit.summary,
        },
      ],
    });
  }
  return result;
}

/** 修改 package.json name（set 或 find/replace） */
export function buildNameChanges(
  components: Component[],
  opts: { target?: string; find?: string; replace?: string }
): ComponentChange[] {
  const result: ComponentChange[] = [];
  for (const c of components) {
    const edit = editName(c.packageJsonPath, opts);
    result.push({
      component: c,
      files: [
        {
          filePath: c.packageJsonPath,
          before: edit.before,
          after: edit.after,
          hits: edit.changed ? 1 : 0,
          summary: edit.summary,
        },
      ],
    });
  }
  return result;
}

/** Feature 5: 按 catalog 精确版本升级工程内组件依赖 */
export function buildUpgradeChanges(
  projects: Component[],
  catalog: Catalog
): ComponentChange[] {
  const result: ComponentChange[] = [];
  for (const p of projects) {
    const edit = editDependencies(p.packageJsonPath, catalog);
    result.push({
      component: p,
      files: [
        {
          filePath: p.packageJsonPath,
          before: edit.before,
          after: edit.after,
          hits: edit.details.length,
          summary: edit.changed ? edit.details.join('; ') : edit.summary,
        },
      ],
    });
  }
  return result;
}
