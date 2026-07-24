import path from 'path';
import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig, resolveScanTarget } from '../../core/configLoader';
import { discoverComponents, readSingleComponent } from '../../core/discover';
import {
  buildNameChanges,
  buildReplaceUrlChanges,
  buildUpgradeChanges,
  buildVersionChanges,
} from '../../core/operations';
import { runChanges } from '../../core/runner';
import { createVirtualSpace } from '../../core/link';
import { syncComponents } from '../../core/repoSync';
import { buildCatalog } from '../../core/catalog';
import { patchVirtualSpace } from '../../core/vsStore';
import { BumpType } from '../../core/version';
import { componentsTarget, projectsTarget, resolveComponents } from '../context';

/** 批量编辑与发布类命令：replace-url / set-version / set-name / link / sync / release / upgrade。 */
export function register(program: Command): void {
  // 替换 yarn.lock 中的 resolved URL
  program
    .command('replace-url')
    .description('批量替换 yarn.lock 中 resolved 的 URL 片段')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
    .option('--projects <dir>', '工程根目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .requiredOption('-f, --from <from>', '要替换的 URL 片段')
    .requiredOption('-t, --to <to>', '替换为的 URL 片段')
    .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
    .option('--dry-run', '仅预览不写入', false)
    .option('--no-backup', '不生成 .bak 备份')
    .option('-y, --yes', '跳过确认', false)
    .option('--diff', '显示 diff 明细', false)
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      const comps = await resolveComponents(config, opts, 'components', { requireYarnLock: true });
      const changes = buildReplaceUrlChanges(comps, opts.from, opts.to);
      await runChanges(changes, {
        dryRun: opts.dryRun,
        backup: opts.backup,
        yes: opts.yes,
        showDiff: opts.diff,
      });
    });

  // 修改 package.json version
  program
    .command('set-version')
    .description('批量修改 package.json 的 version（bump 或指定值，保留 -后缀）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
    .option('--projects <dir>', '工程根目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .option('-b, --bump <level>', '递增级别: patch|minor|major')
    .option('-t, --to <version>', '设为指定版本，如 1.2.0 或 1.2.0-chery')
    .option('--keep-suffix', 'set 模式下若未写后缀则沿用当前后缀', false)
    .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
    .option('--dry-run', '仅预览不写入', false)
    .option('--no-backup', '不生成 .bak 备份')
    .option('-y, --yes', '跳过确认', false)
    .option('--diff', '显示 diff 明细', false)
    .action(async (opts) => {
      if (!opts.bump && !opts.to) {
        logger.error('请提供 --bump <level> 或 --to <version> 之一。');
        process.exitCode = 1;
        return;
      }
      const config = loadConfig(opts.config);
      const comps = await resolveComponents(config, opts, 'components');
      const changes = opts.bump
        ? buildVersionChanges(comps, { mode: 'bump', bump: opts.bump as BumpType })
        : buildVersionChanges(comps, { mode: 'set', target: opts.to, keepSuffix: opts.keepSuffix });
      await runChanges(changes, {
        dryRun: opts.dryRun,
        backup: opts.backup,
        yes: opts.yes,
        showDiff: opts.diff,
      });
    });

  // 修改 package.json name
  program
    .command('set-name')
    .description('批量修改 package.json 的 name（查找替换或设为固定值）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
    .option('--projects <dir>', '工程根目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .option('--find <find>', '要查找的子串')
    .option('--replace <replace>', '替换为', '')
    .option('-t, --to <name>', '整体设为固定 name')
    .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
    .option('--dry-run', '仅预览不写入', false)
    .option('--no-backup', '不生成 .bak 备份')
    .option('-y, --yes', '跳过确认', false)
    .option('--diff', '显示 diff 明细', false)
    .action(async (opts) => {
      if (!opts.find && !opts.to) {
        logger.error('请提供 --find <str> 或 --to <name> 之一。');
        process.exitCode = 1;
        return;
      }
      const config = loadConfig(opts.config);
      const comps = await resolveComponents(config, opts, 'components');
      const changes = opts.to
        ? buildNameChanges(comps, { target: opts.to })
        : buildNameChanges(comps, { find: opts.find, replace: opts.replace });
      await runChanges(changes, {
        dryRun: opts.dryRun,
        backup: opts.backup,
        yes: opts.yes,
        showDiff: opts.diff,
      });
    });

  // 创建虚拟空间（软链）
  program
    .command('link')
    .description('把选定组件以软链聚合到一个虚拟空间目录')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
    .option('--projects <dir>', '工程根目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .requiredOption('-i, --into <into>', '虚拟空间目录')
    .option('--vs <name>', '物化指定命名虚拟空间的成员（替代扫描域组件仓）')
    .option('--force', '覆盖已存在的同名软链', false)
    .option('--dry-run', '仅预览不创建', false)
    .option('-y, --yes', '跳过确认', false)
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      const comps = await resolveComponents(config, opts, 'components');
      await createVirtualSpace(comps, {
        into: opts.into,
        force: opts.force,
        dryRun: opts.dryRun,
        yes: opts.yes,
      });
      if (opts.vs && !opts.dryRun) patchVirtualSpace(opts.vs, { linkedDir: path.resolve(opts.into) });
    });

  // Feature A - 仓同步（仅针对组件）
  program
    .command('sync')
    .description('仓同步（仅组件）：对每个组件 npm pack → npm publish → 清理 tgz')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
    .option('--pack-registry <url>', 'pack 源 registry（覆盖配置）')
    .option('--publish-registry <url>', 'publish 目标 registry（覆盖配置）')
    .option('--work-dir <dir>', '执行 pack/publish 的工作目录（默认临时目录）')
    .option('--pack-retries <n>', 'pack 找不到版本(ETARGET)时的重试次数（应对发布后同步延迟）', (v) => parseInt(v, 10))
    .option('--pack-wait <sec>', '每次 pack 重试的等待秒数（默认 5）', (v) => parseInt(v, 10))
    .option('--dry-run', '仅打印命令不执行', false)
    .option('-y, --yes', '跳过确认', false)
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      let comps;
      if (opts.vs) {
        comps = await resolveComponents(config, opts, 'components');
      } else {
        const target = opts.dir ? { dir: path.resolve(opts.dir) } : componentsTarget(config, opts);
        comps = await discoverComponents(target.dir, { maxDepth: target.maxDepth });
      }
      await syncComponents(comps, {
        packRegistry: opts.packRegistry ?? config.registries.pack,
        publishRegistry: opts.publishRegistry ?? config.registries.publish,
        workDir: opts.workDir,
        dryRun: opts.dryRun,
        yes: opts.yes,
        packRetries: opts.packRetries,
        packRetryDelayMs: opts.packWait != null ? opts.packWait * 1000 : undefined,
      });
    });

  // Feature A2 - 完整发包（构建 → pack → publish）
  program
    .command('release [dir]')
    .description('完整发包：在组件目录依次执行构建步骤（yarn install/lib/gaia …）后 pack → publish（默认当前目录）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('--components [dir]', '批量：扫描组件库根目录下所有组件（省略 dir 时用配置根）')
    .option('--no-build', '跳过构建步骤，仅 pack+publish（等价 sync）')
    .option('--steps <list>', '覆盖构建步骤（分号分隔，如 "yarn install;yarn lib;gaia pub-isd prod"）')
    .option('--pack-registry <url>', 'pack 源 registry（覆盖配置）')
    .option('--publish-registry <url>', 'publish 目标 registry（覆盖配置）')
    .option('--work-dir <dir>', '执行 pack/publish 的工作目录（默认临时目录）')
    .option('--pack-retries <n>', 'pack 找不到版本(ETARGET)时的重试次数（应对发布后同步延迟）', (v) => parseInt(v, 10))
    .option('--pack-wait <sec>', '每次 pack 重试的等待秒数（默认 5）', (v) => parseInt(v, 10))
    .option('--dry-run', '仅打印命令不执行', false)
    .option('-y, --yes', '跳过确认', false)
    .action(async (dir: string | undefined, opts) => {
      const config = loadConfig(opts.config);

      // 构建步骤：--no-build → 空；--steps → 覆盖；否则用配置默认
      let buildSteps: string[];
      if (opts.build === false) {
        buildSteps = [];
      } else if (opts.steps) {
        buildSteps = String(opts.steps).split(';').map((s: string) => s.trim()).filter(Boolean);
      } else {
        buildSteps = config.buildSteps ?? [];
      }

      // 目标：--components 批量；否则把 dir/当前目录当作单个组件
      let comps;
      if (opts.components !== undefined) {
        const root = typeof opts.components === 'string' ? opts.components : resolveScanTarget(config.roots.components).dir;
        const maxDepth = typeof opts.components === 'string' ? undefined : resolveScanTarget(config.roots.components).maxDepth;
        comps = await discoverComponents(root, { maxDepth });
      } else {
        const one = readSingleComponent(dir ?? process.cwd());
        if (!one) {
          logger.error(`当前目录未找到 package.json: ${path.resolve(dir ?? process.cwd())}`);
          process.exitCode = 1;
          return;
        }
        comps = [one];
      }

      await syncComponents(comps, {
        packRegistry: opts.packRegistry ?? config.registries.pack,
        publishRegistry: opts.publishRegistry ?? config.registries.publish,
        workDir: opts.workDir,
        dryRun: opts.dryRun,
        yes: opts.yes,
        buildSteps,
        packRetries: opts.packRetries,
        packRetryDelayMs: opts.packWait != null ? opts.packWait * 1000 : undefined,
      });
    });

  // Feature 5 - upgrade
  program
    .command('upgrade')
    .description('按组件库 catalog 的精确版本升级工程内组件依赖（默认全量，--only 指定组件）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('--projects <dir>', '工程根目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .option('-o, --only <names>', '仅升级指定组件（逗号分隔多个，如 @f6p/a,@f6p/b）')
    .option('--dry-run', '仅预览不写入', false)
    .option('--no-backup', '不生成 .bak 备份')
    .option('-y, --yes', '跳过确认', false)
    .option('--diff', '显示 diff 明细', false)
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      const projT = projectsTarget(config, opts);
      const compT = componentsTarget(config, opts);
      logger.step('扫描工程与组件库 ...');
      const projects = await discoverComponents(projT.dir, { maxDepth: projT.maxDepth });
      const catalog = await buildCatalog(compT.dir, compT.maxDepth);
      const only = opts.only
        ? String(opts.only).split(',').map((s: string) => s.trim()).filter(Boolean)
        : undefined;
      logger.info(
        chalk.dim(
          `工程 ${projects.length} 个，catalog ${catalog.size} 个组件。` +
            (only ? `仅升级指定 ${only.length} 个组件。` : '全量升级。')
        )
      );
      await runChanges(buildUpgradeChanges(projects, catalog, { only }), {
        dryRun: opts.dryRun,
        backup: opts.backup,
        yes: opts.yes,
        showDiff: opts.diff,
      });
      if (!opts.dryRun) {
        logger.warn('升级仅改写 package.json，未改动 yarn.lock；请在各工程重新执行 yarn install。');
      }
    });
}
