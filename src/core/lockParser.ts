import fs from 'fs';

export interface LockEntry {
  /** 该块声明的所有 key（含版本区间），如 ["@babel/code-frame@^7.0.0", ...] */
  keys: string[];
  /** 去区间后的包名（取第一个 key 解析），如 "@babel/code-frame" */
  name: string;
  /** version 字段值 */
  version: string | null;
  /** resolved URL */
  resolved: string | null;
}

/** 去掉外层引号 */
function unquote(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * 从一个 key（如 "@babel/code-frame@^7.10.4"）解析出包名。
 * 兼容 scoped：取最后一个 '@' 之前的部分（scoped 的前导 '@' 在 index 0，不会误伤）。
 */
export function packageNameFromKey(key: string): string {
  const k = unquote(key);
  const at = k.lastIndexOf('@');
  if (at <= 0) return k; // 无版本分隔或本身是 scope 开头
  return k.slice(0, at);
}

/**
 * 轻量解析 yarn.lock v1 为块列表。
 * 块以行首(非缩进、非注释)的 key 行开始，key 行以 ':' 结尾，可能是逗号分隔的多 key。
 */
export function parseYarnLock(content: string): LockEntry[] {
  const lines = content.split('\n');
  const entries: LockEntry[] = [];
  let cur: LockEntry | null = null;

  for (const raw of lines) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    const isHeader = /^[^\s]/.test(raw) && raw.trimEnd().endsWith(':');
    if (isHeader) {
      if (cur) entries.push(cur);
      const headerText = raw.trimEnd().replace(/:$/, '');
      const keys = headerText.split(',').map((s) => unquote(s));
      cur = {
        keys,
        name: packageNameFromKey(keys[0] ?? ''),
        version: null,
        resolved: null,
      };
      continue;
    }

    if (!cur) continue;
    const line = raw.trim();
    if (line.startsWith('version ')) {
      cur.version = unquote(line.slice('version '.length));
    } else if (line.startsWith('resolved ')) {
      cur.resolved = unquote(line.slice('resolved '.length));
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

/** 读取并解析 yarn.lock 文件 */
export function readYarnLock(yarnLockPath: string): LockEntry[] {
  return parseYarnLock(fs.readFileSync(yarnLockPath, 'utf8'));
}
