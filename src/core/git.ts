import { runCommand, runCommandStream } from './exec';

/**
 * 基于 runCommand 的极简 git 封装，均以仓库目录为 cwd。
 * 面向工作流的「工程分支拉取/合并」场景：拉取(fetch+checkout+pull)、合并(merge[+push])。
 *
 * 安全约束（在 engine/steps 层调用）：
 * - merge 前应检查工作区干净（isClean）；
 * - 合并冲突时不自动 abort，标记失败并继续后续仓库，交由用户处理。
 */

/** 该目录是否是一个 git 仓库（含 .git） */
export function isGitRepo(cwd: string): boolean {
  const r = runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.ok && /true/.test(r.stdout);
}

/** 当前分支名；解析失败返回 null（如游离 HEAD） */
export function currentBranch(cwd: string): string | null {
  const r = runCommand('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name && name !== 'HEAD' ? name : null;
}

/** 工作区是否干净（无未提交改动/未跟踪文件） */
export function isClean(cwd: string): boolean {
  const r = runCommand('git', ['status', '--porcelain'], { cwd });
  if (!r.ok) return false;
  return r.stdout.trim().length === 0;
}

/** git fetch（可指定 remote，默认 origin） */
export function fetch(cwd: string, remote = 'origin'): { ok: boolean; message: string } {
  const r = runCommand('git', ['fetch', remote], { cwd });
  return { ok: r.ok, message: (r.stderr || r.stdout).trim() };
}

/** 切换到指定分支 */
export function checkout(cwd: string, branch: string): { ok: boolean; message: string } {
  const r = runCommand('git', ['checkout', branch], { cwd });
  return { ok: r.ok, message: (r.stderr || r.stdout).trim() };
}

/** git pull（当前分支）。带超时避免因认证/网络挂起。 */
export async function pull(cwd: string, remote = 'origin', branch?: string): Promise<{ ok: boolean; message: string }> {
  const args = branch ? ['pull', remote, branch] : ['pull'];
  const r = await runCommandStream('git', args, { cwd });
  return { ok: r.ok, message: (r.stdout + r.stderr).trim() };
}

/**
 * git merge <from>。返回是否成功、是否冲突、输出信息。
 * 冲突时不自动 abort，交调用方处理（避免吞掉历史）。
 */
export async function merge(cwd: string, from: string): Promise<{ ok: boolean; conflict: boolean; message: string }> {
  const r = await runCommandStream('git', ['merge', '--no-edit', from], { cwd });
  const out = (r.stdout + r.stderr).trim();
  const conflict = /CONFLICT|Automatic merge failed|Merge conflict/i.test(out);
  return { ok: r.ok && !conflict, conflict, message: out };
}

/** git push（可指定 remote/branch） */
export async function push(cwd: string, remote = 'origin', branch?: string): Promise<{ ok: boolean; message: string }> {
  const args = branch ? ['push', remote, branch] : ['push'];
  const r = await runCommandStream('git', args, { cwd });
  return { ok: r.ok, message: (r.stdout + r.stderr).trim() };
}
