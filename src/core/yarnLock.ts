import fs from 'fs';

export interface YarnLockEdit {
  before: string;
  after: string;
  changed: boolean;
  hits: number;
  summary: string;
}

/**
 * 只在 `resolved "..."` 行内做替换，避免误伤其它内容。
 * from 为普通子串（非正则），命中即用 to 替换。
 *
 * 例：
 *   resolved "https://npm.f6yc.com/@babel/code-frame/-/...tgz#..."
 *   -> from="https://npm.f6yc.com" to="http://nexus-ditc.mychery.com"
 */
export function replaceResolvedUrlInContent(
  content: string,
  from: string,
  to: string
): { after: string; hits: number } {
  if (!from) return { after: content, hits: 0 };
  let hits = 0;
  // 捕获 resolved 前导（含引号）、URL 主体、结尾引号，保持缩进与格式不变
  const re = /(^[ \t]*resolved[ \t]+")([^"\n]+)(")/gm;
  const after = content.replace(re, (_match, pre: string, url: string, post: string) => {
    if (url.includes(from)) {
      hits += 1;
      return pre + url.split(from).join(to) + post;
    }
    return pre + url + post;
  });
  return { after, hits };
}

/** 读取 yarn.lock 并生成一次 URL 替换的编辑计划 */
export function editYarnLockUrl(
  yarnLockPath: string,
  from: string,
  to: string
): YarnLockEdit {
  const before = fs.readFileSync(yarnLockPath, 'utf8');
  const { after, hits } = replaceResolvedUrlInContent(before, from, to);
  return {
    before,
    after,
    changed: hits > 0 && after !== before,
    hits,
    summary:
      hits > 0 ? `替换 ${hits} 处 resolved URL (${from} -> ${to})` : `无匹配 (${from})`,
  };
}
