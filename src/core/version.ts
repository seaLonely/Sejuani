/**
 * 版本号处理：在保留后缀（如 -chery、+build.1）的前提下做 bump 或替换。
 *
 * 说明：这里不使用严格 semver 的 prerelease 语义，而是把
 * 主版本(major.minor.patch) 之后的所有内容都当作「后缀」原样保留，
 * 以满足 1.0.0-chery -> 1.0.1-chery 这类诉求。
 */

export type BumpType = 'major' | 'minor' | 'patch';

export interface VersionParts {
  major: number;
  minor: number;
  patch: number;
  /** 主版本之后的原始后缀，包含前导的 - 或 +，可能为空串 */
  suffix: string;
}

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(.*)$/;

export function parseVersion(input: string): VersionParts | null {
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    suffix: m[4] ?? '',
  };
}

export function formatVersion(v: VersionParts): string {
  return `${v.major}.${v.minor}.${v.patch}${v.suffix}`;
}

/** 按 patch/minor/major 递增，保留后缀 */
export function bumpVersion(current: string, type: BumpType): string {
  const v = parseVersion(current);
  if (!v) {
    throw new Error(`无法解析版本号: "${current}"`);
  }
  if (type === 'major') {
    v.major += 1;
    v.minor = 0;
    v.patch = 0;
  } else if (type === 'minor') {
    v.minor += 1;
    v.patch = 0;
  } else {
    v.patch += 1;
  }
  return formatVersion(v);
}

/**
 * 显式设置版本。
 * - 若 target 是完整版本号（含 major.minor.patch），直接使用。
 * - 若 keepSuffix 为 true 且 target 不含后缀，则沿用当前版本的后缀。
 */
export function setVersion(
  current: string,
  target: string,
  keepSuffix = false
): string {
  const parsedTarget = parseVersion(target);
  if (!parsedTarget) {
    throw new Error(`目标版本号格式非法: "${target}"`);
  }
  if (keepSuffix && parsedTarget.suffix === '') {
    const cur = parseVersion(current);
    if (cur && cur.suffix) {
      parsedTarget.suffix = cur.suffix;
    }
  }
  return formatVersion(parsedTarget);
}
