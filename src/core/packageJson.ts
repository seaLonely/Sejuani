import fs from 'fs';
import { bumpVersion, BumpType, setVersion } from './version';
import { Catalog } from './catalog';

export interface PackageEdit {
  before: string;
  after: string;
  changed: boolean;
  /** 变更描述，例如 "version 1.0.0-chery -> 1.0.1-chery" */
  summary: string;
}

/** 探测 JSON 文件的缩进（默认 2 空格） */
function detectIndent(source: string): string | number {
  const m = /^[ \t]*[{[]\s*\n([ \t]+)/.exec(source);
  if (!m) return 2;
  const ws = m[1];
  if (ws.includes('\t')) return '\t';
  return ws.length;
}

function serialize(obj: unknown, indent: string | number, hadTrailingNewline: boolean): string {
  const text = JSON.stringify(obj, null, indent);
  return hadTrailingNewline ? text + '\n' : text;
}

/**
 * 修改 package.json 的 version。
 * mode 为 bump 时按 patch/minor/major 递增；为 set 时使用 targetVersion。
 */
export function editVersion(
  packageJsonPath: string,
  opts:
    | { mode: 'bump'; bump: BumpType }
    | { mode: 'set'; target: string; keepSuffix?: boolean }
): PackageEdit {
  const before = fs.readFileSync(packageJsonPath, 'utf8');
  const hadTrailingNewline = before.endsWith('\n');
  const indent = detectIndent(before);
  const pkg = JSON.parse(before);

  const current: string = pkg.version ?? '';
  if (!current) {
    return { before, after: before, changed: false, summary: '无 version 字段，跳过' };
  }

  const next =
    opts.mode === 'bump'
      ? bumpVersion(current, opts.bump)
      : setVersion(current, opts.target, opts.keepSuffix);

  if (next === current) {
    return { before, after: before, changed: false, summary: `version 未变化 (${current})` };
  }

  pkg.version = next;
  const after = serialize(pkg, indent, hadTrailingNewline);
  return { before, after, changed: true, summary: `version ${current} -> ${next}` };
}

/**
 * 修改 package.json 的 name。
 * - 若提供 target，直接设置为 target。
 * - 若提供 find/replace，则在原 name 上做子串替换。
 */
export function editName(
  packageJsonPath: string,
  opts: { target?: string; find?: string; replace?: string }
): PackageEdit {
  const before = fs.readFileSync(packageJsonPath, 'utf8');
  const hadTrailingNewline = before.endsWith('\n');
  const indent = detectIndent(before);
  const pkg = JSON.parse(before);

  const current: string = pkg.name ?? '';
  let next = current;

  if (typeof opts.target === 'string' && opts.target.length > 0) {
    next = opts.target;
  } else if (typeof opts.find === 'string' && opts.find.length > 0) {
    next = current.split(opts.find).join(opts.replace ?? '');
  }

  if (next === current) {
    return { before, after: before, changed: false, summary: `name 未变化 (${current || '空'})` };
  }

  pkg.name = next;
  const after = serialize(pkg, indent, hadTrailingNewline);
  return { before, after, changed: true, summary: `name ${current || '空'} -> ${next}` };
}

export interface DependencyEdit extends PackageEdit {
  /** 逐条依赖变更明细 */
  details: string[];
}

/**
 * 按 catalog 精确版本升级工程内的组件依赖（Feature 5）。
 * 遍历 dependencies + devDependencies，若依赖名在 catalog 中且当前 spec
 * 与 catalog 版本不同，则写成精确版本（catalog 原样，忽略 ^/~ 前缀）。
 * opts.only 非空时，仅升级列表中的组件名（按需升级）。
 */
export function editDependencies(
  packageJsonPath: string,
  catalog: Catalog,
  opts: {
    sections?: Array<'dependencies' | 'devDependencies'>;
    only?: Iterable<string>;
  } = {}
): DependencyEdit {
  const sections = opts.sections ?? ['dependencies', 'devDependencies'];
  const onlySet = opts.only ? new Set(opts.only) : undefined;
  const before = fs.readFileSync(packageJsonPath, 'utf8');
  const hadTrailingNewline = before.endsWith('\n');
  const indent = detectIndent(before);
  const pkg = JSON.parse(before);

  const details: string[] = [];
  for (const section of sections) {
    const block = pkg[section];
    if (!block || typeof block !== 'object') continue;
    for (const name of Object.keys(block)) {
      if (onlySet && !onlySet.has(name)) continue; // 指定模式：只改选中的组件
      const item = catalog.get(name);
      if (!item || !item.version) continue;
      const currentRange = String(block[name]);
      if (currentRange === item.version) continue; // 已是精确目标版本
      block[name] = item.version;
      details.push(`${name} ${currentRange} -> ${item.version} (${section})`);
    }
  }

  if (details.length === 0) {
    return { before, after: before, changed: false, summary: '无可升级组件依赖', details };
  }
  const after = serialize(pkg, indent, hadTrailingNewline);
  return { before, after, changed: true, summary: `升级 ${details.length} 个组件依赖`, details };
}
