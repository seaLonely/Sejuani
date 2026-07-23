import fg from 'fast-glob';
import fs from 'fs';
import path from 'path';
import { Component } from '../types';

export interface DiscoverOptions {
  /** 是否要求组件必须包含 yarn.lock（默认 false） */
  requireYarnLock?: boolean;
  /** 额外忽略的 glob（默认忽略 node_modules） */
  ignore?: string[];
  /** 限制扫描深度（映射 fast-glob deep），用于按约定只扫描 workspace/* 一层 */
  maxDepth?: number;
}

/**
 * 在 baseDir 下发现所有含 package.json 的组件目录。
 * 默认忽略任意层级的 node_modules。
 */
export async function discoverComponents(
  baseDir: string,
  options: DiscoverOptions = {}
): Promise<Component[]> {
  const absBase = path.resolve(baseDir);
  if (!fs.existsSync(absBase)) {
    throw new Error(`目录不存在: ${absBase}`);
  }

  const ignore = ['**/node_modules/**', ...(options.ignore ?? [])];
  const entries = await fg('**/package.json', {
    cwd: absBase,
    ignore,
    absolute: true,
    dot: false,
    onlyFiles: true,
    ...(typeof options.maxDepth === 'number' ? { deep: options.maxDepth } : {}),
  });

  const components: Component[] = [];
  for (const packageJsonPath of entries.sort()) {
    const dir = path.dirname(packageJsonPath);
    const yarnLockPath = path.join(dir, 'yarn.lock');
    const hasLock = fs.existsSync(yarnLockPath);
    if (options.requireYarnLock && !hasLock) continue;

    const comp: Component = {
      name: path.basename(dir),
      dir,
      packageJsonPath,
      yarnLockPath: hasLock ? yarnLockPath : null,
    };

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      comp.pkgName = pkg.name;
      comp.pkgVersion = pkg.version;
    } catch {
      // package.json 解析失败也保留条目，后续操作会跳过
    }

    components.push(comp);
  }

  return components;
}

/**
 * 把单个目录本身当作一个组件读取（用于「当前在组件目录下」的场景）。
 * 直接读取 <dir>/package.json，不做递归扫描；无 package.json 时返回 null。
 */
export function readSingleComponent(dir: string): Component | null {
  const abs = path.resolve(dir);
  const packageJsonPath = path.join(abs, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;
  const yarnLockPath = path.join(abs, 'yarn.lock');
  const hasLock = fs.existsSync(yarnLockPath);
  const comp: Component = {
    name: path.basename(abs),
    dir: abs,
    packageJsonPath,
    yarnLockPath: hasLock ? yarnLockPath : null,
  };
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    comp.pkgName = pkg.name;
    comp.pkgVersion = pkg.version;
  } catch {
    // 解析失败也返回条目，后续操作会因缺少 name/version 跳过
  }
  return comp;
}
