import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Component } from '../types';
import { readYarnLock } from './lockParser';
import { chalk, logger } from '../utils/logger';
import { createProgress } from '../utils/progress';

export interface CheckTarget {
  url: string;
  name: string;
  /** 首个发现该 URL 的组件 */
  component: string;
}

export type CheckStatus = 'exists' | 'missing' | 'auth' | 'error';

export interface CheckResult extends CheckTarget {
  status: CheckStatus;
  httpCode?: number;
  detail?: string;
}

export interface DepCheckOptions {
  concurrency: number;
  /** 单请求超时（毫秒） */
  timeout: number;
  onlyMissing: boolean;
}

/** 收集所有待校验 URL（跨组件去重） */
export function collectResolvedUrls(components: Component[]): CheckTarget[] {
  const seen = new Map<string, CheckTarget>();
  for (const c of components) {
    if (!c.yarnLockPath) continue;
    let entries;
    try {
      entries = readYarnLock(c.yarnLockPath);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.resolved) continue;
      if (!seen.has(e.resolved)) {
        seen.set(e.resolved, { url: e.resolved, name: e.name, component: c.name });
      }
    }
  }
  return [...seen.values()];
}

function classify(code: number): CheckStatus {
  if (code >= 200 && code < 400) return 'exists';
  if (code === 401 || code === 403) return 'auth';
  if (code === 404) return 'missing';
  return 'error';
}

function requestOnce(
  urlStr: string,
  method: 'HEAD' | 'GET',
  timeout: number
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error('非法 URL'));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      { method, timeout },
      (res) => {
        const code = res.statusCode ?? 0;
        res.resume(); // 丢弃 body
        resolve({ code });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('超时'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function checkOne(target: CheckTarget, timeout: number): Promise<CheckResult> {
  try {
    let { code } = await requestOnce(target.url, 'HEAD', timeout);
    // 部分仓库不支持 HEAD，回退 GET
    if (code === 405 || code === 501) {
      ({ code } = await requestOnce(target.url, 'GET', timeout));
    }
    return { ...target, status: classify(code), httpCode: code };
  } catch (err) {
    return { ...target, status: 'error', detail: (err as Error).message };
  }
}

/** 简单并发池（onDone 在每个任务完成后回调，用于进度） */
async function runPool<T, R>(
  items: T[],
  worker: (item: T) => Promise<R>,
  concurrency: number,
  onDone?: () => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(concurrency, items.length)).fill(0).map(async () => {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await worker(items[cur]);
      if (onDone) onDone();
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 批量校验依赖是否存在（直接对 lock 中 resolved URL 发请求）。
 */
export async function checkDependencies(
  components: Component[],
  opts: DepCheckOptions
): Promise<void> {
  const targets = collectResolvedUrls(components);
  logger.title('依赖存在性校验');
  if (targets.length === 0) {
    logger.warn('未发现可校验的 resolved URL。');
    return;
  }
  logger.step(`共 ${targets.length} 个唯一依赖 URL，并发 ${opts.concurrency}，超时 ${opts.timeout}ms ...`);

  const bar = createProgress(targets.length, '  校验 ');
  const results = await runPool(
    targets,
    (t) => checkOne(t, opts.timeout),
    opts.concurrency,
    () => bar.tick(1)
  );
  bar.stop();

  const counts: Record<CheckStatus, number> = { exists: 0, missing: 0, auth: 0, error: 0 };
  for (const r of results) counts[r.status] += 1;

  const problems = results.filter((r) => r.status !== 'exists');
  const toShow = opts.onlyMissing ? problems : results;

  for (const r of toShow) {
    const tag =
      r.status === 'exists'
        ? chalk.green('[存在]')
        : r.status === 'missing'
        ? chalk.red('[缺失404]')
        : r.status === 'auth'
        ? chalk.yellow('[需鉴权]')
        : chalk.magenta('[错误]');
    const extra = r.httpCode ? `HTTP ${r.httpCode}` : r.detail ?? '';
    logger.info(`  ${tag} ${r.name} ${chalk.dim(extra)}`);
    if (r.status !== 'exists') logger.info('        ' + chalk.dim(r.url));
  }

  logger.title('校验汇总');
  logger.info(
    `  总数 ${results.length} | ${chalk.green('存在 ' + counts.exists)} | ${chalk.red(
      '缺失 ' + counts.missing
    )} | ${chalk.yellow('需鉴权 ' + counts.auth)} | ${chalk.magenta('错误 ' + counts.error)}`
  );
  if (counts.missing === 0 && counts.error === 0) {
    logger.success('未发现缺失/错误依赖。');
  } else {
    logger.warn('存在缺失或错误依赖，yarn install 可能失败，请核对上面的清单。');
  }
}
