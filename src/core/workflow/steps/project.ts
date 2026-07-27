import { Component } from '../../types';
import { chalk, logger } from '../../../utils/logger';
import { buildUpgradeChanges } from '../../operations';
import { runChanges } from '../../runner';
import { installProjects, PackageManager } from '../../projectInstall';
import { findProjectsUsing } from '../../usage';
import { runCommand } from '../../exec';
import { StepHandler } from './contract';
import { resolveTargetComponents, resolveTargetProjects, selectedPkgNames, runOverRepos } from './helpers';

/** 工程类步骤：查使用方(find-users) / 依赖升级(upgrade) / 安装(install)。 */

export const projectFindUsers: StepHandler = {
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
    return {
      ok: true,
      reason: `命中 ${ctx.foundProjects.length} 个工程`,
      outputs: { foundProjects: ctx.foundProjects.map((p) => p.pkgName ?? p.name) },
    };
  },
};

export const projectUpgrade: StepHandler = {
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

export const projectVerify: StepHandler = {
  kind: 'project.verify',
  describe: () => ({
    kind: 'project.verify',
    summary: '在目标工程逐个执行验证命令（如构建/测试），任一工程失败即步骤失败；用于升级后验证。',
    params: {
      command: "可选，验证命令，默认 'yarn build'",
    },
    dangerous: false,
  }),
  preview: (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    const command = String(step.params.command ?? 'yarn build');
    return [`对 ${projects.length} 个工程执行验证：$ ${command}`, ...projects.map((p) => `  · ${p.pkgName ?? p.name}`)];
  },
  execute: async (step, ctx) => {
    const projects = resolveTargetProjects(ctx);
    if (projects.length === 0) return { ok: false, reason: '没有目标工程' };
    const command = String(step.params.command ?? 'yarn build').trim();
    const [cmd, ...cmdArgs] = command.split(/\s+/);
    if (!cmd) return { ok: false, reason: '验证命令为空' };
    return runOverRepos(projects, `verify: ${command}`, async (repo) => {
      const r = runCommand(cmd, cmdArgs, { cwd: repo.dir });
      return r.ok
        ? { ok: true }
        : { ok: false, reason: `验证失败(exit=${r.code})：${(r.stderr || r.stdout).slice(-200)}` };
    });
  },
};

export const projectInstall: StepHandler = {
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
