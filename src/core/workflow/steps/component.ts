import { chalk } from '../../../utils/logger';
import { BumpType } from '../../version';
import { buildVersionChanges } from '../../operations';
import { runChanges } from '../../runner';
import { syncComponents } from '../../repoSync';
import { StepHandler } from './contract';
import { resolveTargetComponents } from './helpers';

/** 组件类步骤：改版本(component.bump) / 完整发包(component.release)。 */

export const componentBump: StepHandler = {
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

export const componentRelease: StepHandler = {
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
