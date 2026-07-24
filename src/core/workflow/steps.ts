import inquirer from 'inquirer';
import { Component } from '../../types';
import { chalk, logger } from '../../utils/logger';
import { logEvent } from '../../utils/fileLogger';
import { BumpType } from '../version';
import { buildVersionChanges, buildUpgradeChanges } from '../operations';
import { runChanges } from '../runner';
import { syncComponents } from '../repoSync';
import { installProjects, PackageManager } from '../projectInstall';
import { findProjectsUsing } from '../usage';
import * as git from '../git';
import { StepContext, StepKind, WorkflowStep } from './types';

/**
 * 步骤目录：每种 kind 的能力契约 + 执行实现。
 * - describe()：给 LLM 的 JSON schema 说明（planner 组装 prompt 用）。
 * - preview(step, ctx)：dry-run 文案（多行）。
 * - execute(step, ctx)：真实执行（引擎在非 dry-run 时调用）。
 *
 * 复用现有原语，AI 不改动发布/升级内部细节，只负责编排步骤顺序与参数。
 */

export interface StepExecResult {
  ok: boolean;
  reason?: string;
}

/** 供 planner 拼接 prompt 的步骤能力说明 */
export interface StepDescription {
  kind: StepKind;
  summary: string;
  /** 参数说明：字段名 -> 含义 */
  params: Record<string, string>;
  /** 该 kind 默认是否危险（不可逆） */
  dangerous: boolean;
}

export interface StepHandler {
  kind: StepKind;
  describe(): StepDescription;
  preview(step: WorkflowStep, ctx: StepContext): string[];
  execute(step: WorkflowStep, ctx: StepContext): Promise<StepExecResult>;
}

/** 把 params.components（pkgName/目录名数组）解析为 Component；缺省用选中的组件。 */
function resolveTargetComponents(step: WorkflowStep, ctx: StepContext): Component[] {
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
function resolveTargetProjects(ctx: StepContext): Component[] {
  return ctx.foundProjects.length > 0 ? ctx.foundProjects : ctx.projects;
}

/** 选中组件的 pkgName 列表（供 upgrade 的 only 缺省） */
function selectedPkgNames(ctx: StepContext): string[] {
  return ctx.selectedComponents.map((c) => c.pkgName).filter((n): n is string => !!n);
}

/** 遍历若干仓库执行一个异步操作并汇总（git 步骤复用） */
async function runOverRepos(
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

const componentBump: StepHandler = {
  kind: 'component.bump',
  describe: () => ({
    kind: 'component.bump',
    summary: '修改选定组件 package.json 的版本号（bump 递增或 set 指定值，保留 -后缀）。',
    params: {
      components: '可选，pkgName 数组；缺省对全部选中组件生效',
      bump: "可选，'patch'|'minor'|'major'，与 to 二选一，缺省 patch",
      to: '可选，设为指定版本如 1.2.0 或 1.2.0-chery',
    },
    dangerous: false,
  }),
  preview: (step, ctx) => {
    const comps = resolveTargetComponents(step, ctx);
    const how = step.params.to ? `set → ${step.params.to}` : `bump ${step.params.bump ?? 'patch'}`;
    return [`修改版本(${how})：`, ...comps.map((c) => `  · ${c.pkgName ?? c.name} @ ${c.pkgVersion ?? '?'}`)];
  },
  execute: async (step, ctx) => {
    const comps = resolveTargetComponents(step, ctx);
    if (comps.length === 0) return { ok: false, reason: '没有目标组件' };
    const changes = step.params.to
      ? buildVersionChanges(comps, { mode: 'set', target: String(step.params.to), keepSuffix: true })
      : buildVersionChanges(comps, { mode: 'bump', bump: (step.params.bump ?? 'patch') as BumpType });
    const r = await runChanges(changes, { dryRun: false, backup: true, yes: true, showDiff: false });
    return { ok: true, reason: `修改 ${r.filesChanged} 个 package.json` };
  },
};

const componentRelease: StepHandler = {
  kind: 'component.release',
  describe: () => ({
    kind: 'component.release',
    summary: '完整发包并同步奇瑞：在组件目录执行构建步骤(yarn install/lib/gaia)后 pack→publish。不可逆。',
    params: {
      components: '可选，pkgName 数组；缺省对全部选中组件生效',
      build: '可选，boolean；true(默认)=完整发包(含构建)，false=仅 pack+publish',
    },
    dangerous: true,
  }),
  preview: (step, ctx) => {
    const comps = resolveTargetComponents(step, ctx);
    const build = step.params.build !== false;
    const steps = build ? (ctx.config.buildSteps ?? []).join(' → ') + ' → pack → publish' : 'pack → publish';
    return [
      chalk.yellow('⚠ 不可逆：发布到 registry 并同步奇瑞'),
      `构建/发布：${steps}`,
      ...comps.map((c) => `  · ${c.pkgName ?? c.name}@${c.pkgVersion ?? '?'}`),
    ];
  },
  execute: async (step, ctx) => {
    const comps = resolveTargetComponents(step, ctx);
    if (comps.length === 0) return { ok: false, reason: '没有目标组件' };
    const buildSteps = step.params.build === false ? [] : ctx.config.buildSteps ?? [];
    await syncComponents(comps, {
      packRegistry: ctx.config.registries.pack,
      publishRegistry: ctx.config.registries.publish,
      dryRun: false,
      yes: true,
      buildSteps,
    });
    return { ok: true, reason: `发布 ${comps.length} 个组件` };
  },
};

const projectFindUsers: StepHandler = {
  kind: 'project.find-users',
  describe: () => ({
    kind: 'project.find-users',
    summary: '查询「使用了选定组件」的工程集合，写入上下文供后续 upgrade/install/git 步骤消费。',
    params: {
      components: '可选，pkgName 数组；缺省用全部选中组件',
    },
    dangerous: false,
  }),
  preview: (step, ctx) => {
    const comps = resolveTargetComponents(step, ctx);
    return ['查询使用了以下组件的工程：', ...comps.map((c) => `  · ${c.pkgName ?? c.name}`)];
  },
  execute: async (step, ctx) => {
    const comps = resolveTargetComponents(step, ctx);
    const names = comps.map((c) => c.pkgName).filter((n): n is string => !!n);
    const byDir = new Map<string, Component>();
    for (const name of names) {
      for (const h of findProjectsUsing(name, ctx.projects)) {
        const proj = ctx.projects.find((p) => p.name === h.project || p.pkgName === h.project);
        if (proj) byDir.set(proj.dir, proj);
      }
    }
    ctx.foundProjects = [...byDir.values()];
    logger.title('使用了目标组件的工程');
    if (ctx.foundProjects.length === 0) {
      logger.warn('  未发现任何工程使用这些组件。');
    } else {
      for (const p of ctx.foundProjects) logger.info('  ' + chalk.cyan(p.pkgName ?? p.name));
    }
    return { ok: true, reason: `命中 ${ctx.foundProjects.length} 个工程` };
  },
};

const projectUpgrade: StepHandler = {
  kind: 'project.upgrade',
  describe: () => ({
    kind: 'project.upgrade',
    summary: '按组件库 catalog 精确版本升级工程内组件依赖（改写 package.json，不改 yarn.lock）。',
    params: {
      only: '可选，pkgName 数组；缺省用选中的组件（若为空则全量升级）',
    },
    dangerous: false,
  }),
  preview: (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    const only = Array.isArray(step.params.only) && step.params.only.length > 0
      ? step.params.only.map(String)
      : selectedPkgNames(ctx);
    return [
      `升级 ${projects.length} 个工程的组件依赖到 catalog 精确版本`,
      only.length > 0 ? `  仅：${only.join(', ')}` : '  全量升级',
    ];
  },
  execute: async (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    if (projects.length === 0) return { ok: false, reason: '没有目标工程' };
    const only = Array.isArray(step.params.only) && step.params.only.length > 0
      ? step.params.only.map(String)
      : selectedPkgNames(ctx);
    const changes = buildUpgradeChanges(projects, ctx.catalog, { only: only.length > 0 ? only : undefined });
    const r = await runChanges(changes, { dryRun: false, backup: true, yes: true, showDiff: false });
    logger.warn('  升级仅改写 package.json；后续请执行 project.install 或手动 yarn install。');
    return { ok: true, reason: `升级 ${r.componentsChanged} 个工程、${r.filesChanged} 个文件` };
  },
};

const projectInstall: StepHandler = {
  kind: 'project.install',
  describe: () => ({
    kind: 'project.install',
    summary: '在目标工程逐个执行 yarn/npm install，同步 lockfile 与 node_modules。',
    params: {
      pm: "可选，'yarn'(默认)|'npm'",
    },
    dangerous: false,
  }),
  preview: (_step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    return [`对 ${projects.length} 个工程执行 install：`, ...projects.map((p) => `  · ${p.pkgName ?? p.name}`)];
  },
  execute: async (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    if (projects.length === 0) return { ok: false, reason: '没有目标工程' };
    const pm = (step.params.pm === 'npm' ? 'npm' : 'yarn') as PackageManager;
    const summary = installProjects(projects, { pm });
    if (summary.failed.length > 0) {
      return { ok: false, reason: `${summary.failed.length}/${summary.results.length} 个工程 install 失败` };
    }
    return { ok: true, reason: `${summary.okCount} 个工程 install 成功` };
  },
};

const gitPull: StepHandler = {
  kind: 'git.pull',
  describe: () => ({
    kind: 'git.pull',
    summary: '对目标工程执行 git fetch + (可选 checkout <branch>) + pull。',
    params: {
      branch: '可选，要切换并拉取的分支名；缺省在当前分支 pull',
      remote: "可选，远程名，默认 'origin'",
    },
    dangerous: false,
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

const gitMerge: StepHandler = {
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

/** 全部步骤处理器（kind -> handler） */
export const STEP_HANDLERS: Record<StepKind, StepHandler> = {
  'component.bump': componentBump,
  'component.release': componentRelease,
  'project.find-users': projectFindUsers,
  'project.upgrade': projectUpgrade,
  'project.install': projectInstall,
  'git.pull': gitPull,
  'git.merge': gitMerge,
};

/** 是否已知的步骤 kind */
export function isKnownKind(kind: string): kind is StepKind {
  return Object.prototype.hasOwnProperty.call(STEP_HANDLERS, kind);
}

/** 取全部步骤的能力说明（planner 拼 prompt 用） */
export function describeAllSteps(): StepDescription[] {
  return Object.values(STEP_HANDLERS).map((h) => h.describe());
}

/** 危险步骤默认标记（planner 规整时用） */
export function isDangerousByDefault(kind: StepKind): boolean {
  return STEP_HANDLERS[kind].describe().dangerous;
}

/** 供引擎在危险步骤前二次确认（yes 时跳过） */
export async function confirmDangerous(step: WorkflowStep): Promise<boolean> {
  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    {
      type: 'confirm',
      name: 'ok',
      message: `危险步骤「${step.title}」(${step.kind}) 不可逆，确认执行?`,
      default: false,
    },
  ]);
  return ok;
}
