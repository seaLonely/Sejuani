import fs from 'fs';
import path from 'path';
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  DEFAULT_DOMAIN,
  RootConfig,
  SejuaniConfig,
} from '../config';
import { getActiveDomainOverride } from './domainState';

/** 从 startDir 向上逐级查找 sejuani.config.json */
function findConfigFile(startDir: string): string | null {
  let dir = path.resolve(startDir);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function deepMerge<T>(base: T, override: Partial<T> | undefined): T {
  if (!override) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

/**
 * 依「当前域」把该域的 roots/registries 展开到顶层。
 * 优先级：~/.sejuani/state.json > config.activeDomain > 默认域。
 * 若配置文件显式提供了顶层 roots/registries，则保留其显式值（不被域覆盖）。
 */
function applyActiveDomain(
  config: SejuaniConfig,
  explicit: { roots?: boolean; registries?: boolean } = {}
): SejuaniConfig {
  const key = getActiveDomainOverride() ?? config.activeDomain ?? DEFAULT_DOMAIN;
  const domain = config.domains?.[key];
  const next: SejuaniConfig = { ...config, activeDomain: key };
  if (!domain) return next;
  if (!explicit.roots) next.roots = domain.roots;
  if (!explicit.registries) next.registries = domain.registries;
  return next;
}

/**
 * 加载配置：显式 --config 优先，其次就近查找，最后回退内置默认。
 * 加载后按当前域展开 roots/registries。
 */
export function loadConfig(explicitPath?: string, startDir = process.cwd()): SejuaniConfig {
  const file = explicitPath
    ? path.resolve(explicitPath)
    : findConfigFile(startDir);

  if (!file) return applyActiveDomain(DEFAULT_CONFIG);
  if (!fs.existsSync(file)) {
    throw new Error(`配置文件不存在: ${file}`);
  }

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SejuaniConfig>;
    const merged = deepMerge(DEFAULT_CONFIG, raw);
    return applyActiveDomain(merged, {
      roots: !!raw.roots,
      registries: !!raw.registries,
    });
  } catch (err) {
    throw new Error(`配置文件解析失败 ${file}: ${(err as Error).message}`);
  }
}

/**
 * 按约定把一个 RootConfig 解析为实际要扫描的目录与深度：
 * 若 <root>/<packagesDir> 存在则扫描它并用 depth；否则直接扫描 root（不限深度）。
 */
export function resolveScanTarget(cfg: RootConfig): { dir: string; maxDepth?: number } {
  const packages = path.join(cfg.root, cfg.packagesDir);
  if (cfg.packagesDir && fs.existsSync(packages)) {
    // config.depth 表示 packagesDir 下的子目录层数；fast-glob 的 deep 还需 +1
    // 才能匹配到叶子目录中的 package.json（如 depth=1 -> workspace/*/package.json）。
    return { dir: packages, maxDepth: cfg.depth + 1 };
  }
  return { dir: cfg.root };
}
