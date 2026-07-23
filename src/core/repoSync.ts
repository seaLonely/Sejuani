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
}

interface SyncItemResult {
  component: string;
  spec: string;
  ok: boolean;
  reason?: string;
}

/** 从 npm pack --json 输出中解析出 tgz 文件名 */
function parsePackFilename(stdout: string): string | null {
  try {
    const arr = JSON.parse(stdout);
    if (Array.isArray(arr) && arr[0] && typeof arr[0].filename === 'string') {
      return arr[0].filename;
    }
  } catch {
    // 回退：取最后一行非空输出
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && last.endsWith('.tgz')) return last;
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
    logger.warn('所选组件均缺少 name/version，无法同步。');
    return;
  }

  logger.title('仓同步计划（pack → publish → 清理 tgz）');
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
      logger.info('  ' + chalk.cyan(spec));
      logger.info(
        '    $ ' + chalk.dim(formatCommand('npm', ['pack', spec, `--registry=${opts.packRegistry}`, '--json']))
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
        message: `确认对 ${targets.length} 个组件执行 pack+publish?`,
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
  for (const c of targets) {
    const spec = `${c.pkgName}@${c.pkgVersion}`;
    logger.step(`处理 ${chalk.cyan(spec)}`);

    const packRes = runCommand(
      'npm',
      ['pack', spec, `--registry=${opts.packRegistry}`, '--json'],
      { cwd: workDir }
    );
    if (!packRes.ok) {
      results.push({ component: c.name, spec, ok: false, reason: `pack 失败: ${packRes.stderr.trim() || packRes.code}` });
      logger.error(`  pack 失败: ${packRes.stderr.trim()}`);
      continue;
    }
    const filename = parsePackFilename(packRes.stdout);
    if (!filename) {
      results.push({ component: c.name, spec, ok: false, reason: 'pack 未产出 tgz 文件名' });
      logger.error('  未能解析出 tgz 文件名');
      continue;
    }
    const tgzPath = path.join(workDir, filename);

    const pubRes = runCommand(
      'npm',
      ['publish', tgzPath, `--registry=${opts.publishRegistry}`],
      { cwd: workDir }
    );

    // 清理 tgz（无论 publish 成功与否）
    try {
      fs.rmSync(tgzPath, { force: true });
    } catch {
      /* ignore */
    }

    if (!pubRes.ok) {
      results.push({ component: c.name, spec, ok: false, reason: `publish 失败: ${pubRes.stderr.trim() || pubRes.code}` });
      logger.error(`  publish 失败: ${pubRes.stderr.trim()}`);
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
  logger.title('仓同步结果');
  logger.success(`成功: ${okCount}/${results.length}`);
  if (failed.length > 0) {
    logger.warn(`失败 ${failed.length} 个:`);
    for (const f of failed) {
      logger.info('  ' + chalk.red(f.spec) + chalk.dim(`  ${f.reason ?? ''}`));
    }
  }
}
