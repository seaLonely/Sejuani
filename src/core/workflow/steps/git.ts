import { chalk, logger } from '../../../utils/logger';
import * as git from '../../git';
import * as yunxiao from '../../yunxiao/api';
import { StepHandler } from './contract';
import { requireYunxiao, resolveTargetProjects, runOverRepos } from './helpers';

/** git 类步骤：批量 pull / 批量 merge / 修复分支提交并创建云效 MR。 */

export const gitPull: StepHandler = {
  kind: 'git.pull',
  describe: () => ({
    kind: 'git.pull',
    summary: '对目标工程执行 git fetch + (可选 checkout <branch>) + pull。',
    params: {
      branch: '可选，要切换并拉取的分支名；缺省在当前分支 pull',
      remote: "可选，远程名，默认 'origin'",
    },
    dangerous: false,
    defaultRetry: { max: 2, delayMs: 3000 },
  }),
  preview: (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    const br = step.params.branch ? `checkout ${step.params.branch} + ` : '';
    return [`对 ${projects.length} 个工程执行 ${br}pull：`, ...projects.map((p) => `  · ${p.pkgName ?? p.name}`)];
  },
  execute: async (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    const remote = step.params.remote ? String(step.params.remote) : 'origin';
    const branch = step.params.branch ? String(step.params.branch) : undefined;
    return runOverRepos(projects, `pull${branch ? ` (${branch})` : ''}`, async (repo) => {
      if (!git.isGitRepo(repo.dir)) return { ok: false, reason: '非 git 仓库' };
      const f = git.fetch(repo.dir, remote);
      if (!f.ok) return { ok: false, reason: `fetch 失败: ${f.message}` };
      if (branch) {
        const co = git.checkout(repo.dir, branch);
        if (!co.ok) return { ok: false, reason: `checkout ${branch} 失败: ${co.message}` };
      }
      const p = await git.pull(repo.dir, remote, branch);
      return p.ok ? { ok: true } : { ok: false, reason: `pull 失败: ${p.message}` };
    });
  },
};

export const gitMerge: StepHandler = {
  kind: 'git.merge',
  describe: () => ({
    kind: 'git.merge',
    summary: '对目标工程执行 git merge <from>（可选 push）。冲突则标记失败并继续后续仓库，不自动 abort。不可逆。',
    params: {
      from: '必填，要合并进当前分支的来源分支名',
      push: '可选，boolean；true=合并成功后 push',
      remote: "可选，push 的远程名，默认 'origin'",
    },
    dangerous: true,
  }),
  preview: (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    const doPush = step.params.push ? ' + push' : '';
    return [
      chalk.yellow(`⚠ 不可逆：merge ${step.params.from ?? '<from>'}${doPush}`),
      `对 ${projects.length} 个工程执行：`,
      ...projects.map((p) => `  · ${p.pkgName ?? p.name}`),
    ];
  },
  execute: async (step, ctx) => {
    const from = step.params.from ? String(step.params.from) : '';
    if (!from) return { ok: false, reason: '缺少 from 分支' };
    const projects = resolveTargetProjects(ctx);
    const doPush = !!step.params.push;
    const remote = step.params.remote ? String(step.params.remote) : 'origin';
    return runOverRepos(projects, `merge ${from}${doPush ? ' + push' : ''}`, async (repo) => {
      if (!git.isGitRepo(repo.dir)) return { ok: false, reason: '非 git 仓库' };
      if (!git.isClean(repo.dir)) return { ok: false, reason: '工作区不干净，已跳过合并' };
      const m = await git.merge(repo.dir, from);
      if (m.conflict) return { ok: false, reason: '合并冲突（未自动 abort，请手动处理）' };
      if (!m.ok) return { ok: false, reason: `merge 失败: ${m.message}` };
      if (doPush) {
        const p = await git.push(repo.dir, remote);
        if (!p.ok) return { ok: false, reason: `push 失败: ${p.message}` };
      }
      return { ok: true };
    });
  },
};

export const gitMr: StepHandler = {
  kind: 'git.mr',
  describe: () => ({
    kind: 'git.mr',
    summary: '把 AI 修复的改动建分支→提交→push，并在云效创建合并请求(MR)。不可逆（推送远端）。',
    params: {
      targetBranch: '可选，MR 目标分支；缺省用上下文 targetBranch',
      branchPrefix: "可选，工作分支前缀，默认 'fix'",
    },
    dangerous: true,
  }),
  preview: (step, ctx) => {
    const y = requireYunxiao(ctx);
    const target = step.params.targetBranch ? String(step.params.targetBranch) : y.targetBranch;
    return [
      chalk.yellow('⚠ 不可逆：推送分支并在云效创建 MR'),
      `工程：${y.repoDir}`,
      `目标分支：${target}`,
    ];
  },
  execute: async (step, ctx) => {
    const y = requireYunxiao(ctx);
    if (!git.isGitRepo(y.repoDir)) return { ok: false, reason: `目标目录不是 git 仓库：${y.repoDir}` };
    if (!git.hasChanges(y.repoDir)) return { ok: false, reason: 'AI 未产生改动，无可提交内容，已跳过 MR' };

    const prefix = step.params.branchPrefix ? String(step.params.branchPrefix) : 'fix';
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const branch = y.workBranch ?? `${prefix}/${y.issue.identifier}-${ts}`.replace(/[^a-zA-Z0-9._/-]/g, '-');
    const target = step.params.targetBranch ? String(step.params.targetBranch) : y.targetBranch;

    const cb = git.createBranch(y.repoDir, branch);
    if (!cb.ok) return { ok: false, reason: `创建分支失败: ${cb.message}` };
    y.workBranch = branch;
    const ad = git.add(y.repoDir);
    if (!ad.ok) return { ok: false, reason: `git add 失败: ${ad.message}` };
    const cm = git.commit(y.repoDir, `fix: ${y.issue.subject}（${y.issue.identifier}）`);
    if (!cm.ok) return { ok: false, reason: `git commit 失败: ${cm.message}` };
    const ps = await git.push(y.repoDir, 'origin', branch, true);
    if (!ps.ok) return { ok: false, reason: `git push 失败: ${ps.message}` };

    const repoId = y.repoId ?? git.getRemoteRepoIdentity(y.repoDir) ?? undefined;
    if (!repoId) {
      return { ok: false, reason: '无法从 origin 解析云效代码库标识，请用 --repo-id 显式指定后 flow resume。' };
    }
    const mr = await yunxiao.createMergeRequest(repoId, {
      sourceBranch: branch,
      targetBranch: target,
      title: `fix: ${y.issue.subject}（${y.issue.identifier}）`,
      description: `由 Sejuani 自动化修复工单 ${y.issue.identifier} 生成。`,
    });
    y.mrUrl = mr.webUrl;
    if (mr.webUrl) logger.success(`  已创建 MR：${chalk.cyan(mr.webUrl)}`);
    return {
      ok: true,
      reason: mr.webUrl ? `MR: ${mr.webUrl}` : '已创建 MR',
      outputs: { mrUrl: mr.webUrl, workBranch: branch },
    };
  },
};
