import { Component } from '../../types';
import { chalk, logger } from '../../../utils/logger';
import { logEvent } from '../../../utils/fileLogger';
import { StepContext, WorkflowStep } from '../types';
import { StepExecResult } from './contract';

/** 各步骤实现共享的目标解析与批量执行小工具。 */

/** 把 params.components（pkgName/目录名数组）解析为 Component；缺省用选中的组件。 */
export function resolveTargetComponents(step: WorkflowStep, ctx: StepContext): Component[] {
  const names: string[] | undefined = Array.isArray(step.params.components)
    ? step.params.components.map(String)
    : undefined;
  if (!names || names.length === 0) return ctx.selectedComponents;
  const pool = ctx.components.length > 0 ? ctx.components : ctx.selectedComponents;
  const picked: Component[] = [];
  for (const n of names) {
    const hit = pool.find((c) => c.pkgName === n || c.name === n);
    if (hit) picked.push(hit);
  }
  return picked.length > 0 ? picked : ctx.selectedComponents;
}

/** 目标工程：优先 find-users 的产出，否则用工程根下全部工程。 */
export function resolveTargetProjects(ctx: StepContext): Component[] {
  return ctx.foundProjects.length > 0 ? ctx.foundProjects : ctx.projects;
}

/** 选中组件的 pkgName 列表（供 upgrade 的 only 缺省） */
export function selectedPkgNames(ctx: StepContext): string[] {
  return ctx.selectedComponents.map((c) => c.pkgName).filter((n): n is string => !!n);
}

/** 遍历若干仓库执行一个异步操作并汇总（git 步骤复用） */
export async function runOverRepos(
  repos: Component[],
  label: string,
  fn: (repo: Component) => Promise<{ ok: boolean; reason?: string }>
): Promise<StepExecResult> {
  if (repos.length === 0) return { ok: true, reason: '没有目标工程' };
  logEvent('info', 'repos.start', { label, repos: repos.map((r) => r.name), count: repos.length });
  const failed: string[] = [];
  let done = 0;
  for (const r of repos) {
    logger.step(`[${++done}/${repos.length}] ${label} ${chalk.dim(`(cwd: ${r.dir})`)}`);
    logEvent('debug', 'repo.cmd', { label, repo: r.name, dir: r.dir });
    const res = await fn(r);
    if (res.ok) {
      logger.success(`  完成 ${r.name}`);
      logEvent('info', 'repo.ok', { label, repo: r.name });
    } else {
      failed.push(`${r.name}: ${res.reason ?? '失败'}`);
      logger.error(`  ${r.name} ${res.reason ?? '失败'}`);
      logEvent('error', 'repo.failed', { label, repo: r.name, reason: res.reason ?? '失败' });
    }
  }
  if (failed.length > 0) {
    return { ok: false, reason: `${failed.length}/${repos.length} 个仓库失败：${failed.join('；')}` };
  }
  return { ok: true, reason: `${repos.length} 个仓库全部成功` };
}

/** 取云效修复流数据；缺失时抛错（这些步骤只应出现在 fix-bug 工作流里）。 */
export function requireYunxiao(ctx: StepContext): NonNullable<StepContext['yunxiao']> {
  if (!ctx.yunxiao) {
    throw new Error('该步骤仅用于云效修复流，缺少 ctx.yunxiao 上下文。');
  }
  return ctx.yunxiao;
}

/** 把评论模板里的占位符替换为运行时值（{mrUrl}/{branch}/{identifier}）。 */
export function renderCommentContent(raw: string, ctx: StepContext): string {
  const y = ctx.yunxiao;
  return raw
    .replace(/\{mrUrl\}/g, y?.mrUrl ?? '(待生成)')
    .replace(/\{branch\}/g, y?.workBranch ?? '(待创建)')
    .replace(/\{identifier\}/g, y?.issue.identifier ?? '');
}
