import fs from 'fs';
import os from 'os';
import path from 'path';
import inquirer from 'inquirer';
import { Component } from '../types';
import { runCommand, formatCommand } from './exec';
import { chalk, logger } from '../utils/logger';

export interface SyncOptions {
  packRegistry: string;
  publishRegistry: string;
  /** 执行 pack/publish 的工作目录，默认临时目录 */
  workDir?: string;
  dryRun: boolean;
  yes: boolean;
  /**
   * 完整发布：pack/publish 之前在每个组件自己的目录依次执行的构建步骤
   * （如 yarn install / yarn lib / gaia pub-isd prod）。为空则仅镜像(pack+publish)。
   */
  buildSteps?: string[];
}

interface SyncItemResult {
  component: string;
  spec: string;
  ok: boolean;
  reason?: string;
}

/**
 * 推算 npm pack 落盘的 tgz 文件名（与 npm 一致）：
 * scoped 包 @scope/name 会被拍平为 scope-name，拼上 -version.tgz。
 * 例：@f6p/income-separate-setting@1.0.2-chery -> f6p-income-separate-setting-1.0.2-chery.tgz
 */
function expectedTgzName(pkgName: string, pkgVersion: string): string {
  return `${pkgName.replace(/^@/, '').replace(/\//g, '-')}-${pkgVersion}.tgz`;
}

/**
 * 解析 pack 真实落盘的 tgz 路径。
 * 注意：scoped 包（@scope/name）在磁盘上会被拍平成 scope-name-version.tgz；
 * 这里对多种候选名做存在性探测，并最终兜底扫描 workDir 下的 .tgz。
 */
function resolveTgzPath(workDir: string, filename: string): string | null {
  const candidates = [
    filename, // 原样
    filename.replace(/^@/, '').replace(/\//g, '-'), // @scope/name -> scope-name
    path.basename(filename), // 仅取文件名部分
  ];
  for (const c of candidates) {
    const p = path.join(workDir, c);
    if (fs.existsSync(p)) return p;
  }
  // 兜底：workDir 内唯一的 .tgz（每次 publish 后都会清理，pack 后应只剩这一个）
  try {
    const tgzs = fs.readdirSync(workDir).filter((f) => f.endsWith('.tgz'));
    if (tgzs.length === 1) return path.join(workDir, tgzs[0]);
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 仓同步：对每个组件执行 npm pack <name@version> → npm publish <tgz> → 删除 tgz。
 * 逐组件容错，最后汇总。
 */
export async function syncComponents(
  components: Component[],
  opts: SyncOptions
): Promise<void> {
  const targets = components.filter((c) => c.pkgName && c.pkgVersion);
  if (targets.length === 0) {
    logger.warn('所选组件均缺少 name/version，无法处理。');
    return;
  }

  const buildSteps = opts.buildSteps?.filter((s) => s.trim()) ?? [];
  const full = buildSteps.length > 0;

  logger.title(full ? '完整发布计划（build → pack → publish → 清理 tgz）' : '仓同步计划（pack → publish → 清理 tgz）');
  if (full) logger.info(chalk.dim(`构建步骤: ${buildSteps.join(' → ')}`));
  logger.info(chalk.dim(`pack   源: ${opts.packRegistry}`));
  logger.info(chalk.dim(`publish 目标: ${opts.publishRegistry}`));
  for (const c of targets) {
    const spec = `${c.pkgName}@${c.pkgVersion}`;
    logger.info('  ' + chalk.cyan(spec));
  }

  if (opts.dryRun) {
    logger.title('[dry-run] 将执行的命令');
    for (const c of targets) {
      const spec = `${c.pkgName}@${c.pkgVersion}`;
      logger.info('  ' + chalk.cyan(spec) + chalk.dim(`  (cwd: ${c.dir})`));
      for (const step of buildSteps) {
        logger.info('    $ ' + chalk.dim(step));
      }
      logger.info(
        '    $ ' + chalk.dim(formatCommand('npm', ['pack', spec, `--registry=${opts.packRegistry}`]))
      );
      logger.info(
        '    $ ' + chalk.dim(formatCommand('npm', ['publish', '<tgz>', `--registry=${opts.publishRegistry}`]))
      );
      logger.info('    $ ' + chalk.dim('rm <tgz>'));
    }
    logger.info(chalk.yellow('\n[dry-run] 未实际执行。'));
    return;
  }

  if (!opts.yes) {
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: `确认对 ${targets.length} 个组件执行 ${full ? '构建+pack+publish' : 'pack+publish'}?`,
        default: false,
      },
    ]);
    if (!confirmed) {
      logger.warn('已取消。');
      return;
    }
  }

  const workDir = opts.workDir
    ? path.resolve(opts.workDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'sejuani-'));
  fs.mkdirSync(workDir, { recursive: true });
  const usingTemp = !opts.workDir;

  const results: SyncItemResult[] = [];
  let done = 0;
  for (const c of targets) {
    const spec = `${c.pkgName}@${c.pkgVersion}`;
    logger.step(`[${++done}/${targets.length}] 处理 ${chalk.cyan(spec)}`);

    // 完整发布：先在组件自己的目录依次执行构建步骤（实时输出）
    let buildFailed: string | null = null;
    for (const step of buildSteps) {
      const [scmd, ...sargs] = step.split(/\s+/);
      logger.info('  ' + chalk.dim('$ ') + chalk.cyan(step) + chalk.dim(`  (cwd: ${c.dir})`));
      const r = runCommand(scmd, sargs, { cwd: c.dir, inherit: true });
      if (!r.ok) {
        buildFailed = step;
        break;
      }
    }
    if (buildFailed) {
      results.push({ component: c.name, spec, ok: false, reason: `构建失败: ${buildFailed}` });
      logger.error(`  构建步骤失败，已跳过后续 pack/publish: ${buildFailed}`);
      continue;
    }

    // pack：直接透传 stdio（实时输出 + 允许私有仓交互认证，避免卡在不可见的提示上）
    logger.info(
      '  ' + chalk.dim('$ ') + chalk.cyan(`npm pack ${spec} --registry=${opts.packRegistry}`) + chalk.dim(`  (cwd: ${workDir})`)
    );
    const packRes = runCommand(
      'npm',
      ['pack', spec, `--registry=${opts.packRegistry}`],
      { cwd: workDir, inherit: true }
    );
    if (!packRes.ok) {
      results.push({ component: c.name, spec, ok: false, reason: `pack 失败: exit ${packRes.code}` });
      logger.error(`  pack 失败（exit ${packRes.code}），请检查上方 npm 输出`);
      continue;
    }
    const tgzPath = resolveTgzPath(workDir, expectedTgzName(c.pkgName!, c.pkgVersion!));
    if (!tgzPath) {
      results.push({ component: c.name, spec, ok: false, reason: 'pack 产出的 tgz 未找到' });
      logger.error('  pack 产出的 tgz 未找到（磁盘无匹配文件）');
      continue;
    }

    // publish：同样透传 stdio，便于看到进度/错误并响应可能的认证提示
    logger.info(
      '  ' + chalk.dim('$ ') + chalk.cyan(`npm publish ${path.basename(tgzPath)} --registry=${opts.publishRegistry}`)
    );
    const pubRes = runCommand(
      'npm',
      ['publish', tgzPath, `--registry=${opts.publishRegistry}`],
      { cwd: workDir, inherit: true }
    );

    // 清理 tgz（无论 publish 成功与否）
    try {
      fs.rmSync(tgzPath, { force: true });
    } catch {
      /* ignore */
    }

    if (!pubRes.ok) {
      results.push({ component: c.name, spec, ok: false, reason: `publish 失败: exit ${pubRes.code}` });
      logger.error(`  publish 失败（exit ${pubRes.code}），请检查上方 npm 输出`);
      continue;
    }
    results.push({ component: c.name, spec, ok: true });
    logger.success(`  完成 ${spec}`);
  }

  // 清理临时工作目录
  if (usingTemp) {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  logger.title(full ? '完整发布结果' : '仓同步结果');
  logger.success(`成功: ${okCount}/${results.length}`);
  if (failed.length > 0) {
    logger.warn(`失败 ${failed.length} 个:`);
    for (const f of failed) {
      logger.info('  ' + chalk.red(f.spec) + chalk.dim(`  ${f.reason ?? ''}`));
    }
  }
}
