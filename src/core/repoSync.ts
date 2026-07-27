import fs from 'fs';
import os from 'os';
import path from 'path';
import { Component, ConfirmFn } from './types';
import { runCommand, runCommandStream, formatCommand } from './exec';
import { chalk, logger } from '../utils/logger';

export interface SyncOptions {
  packRegistry: string;
  publishRegistry: string;
  /** 执行 pack/publish 的工作目录，默认临时目录 */
  workDir?: string;
  dryRun: boolean;
  yes: boolean;
  /** 确认回调（yes=false 时生效）；未提供时视为拒绝 */
  confirm?: ConfirmFn;
  /**
   * 完整发布：pack/publish 之前在每个组件自己的目录依次执行的构建步骤
   * （如 yarn install / yarn lib / gaia pub-isd prod）。为空则仅镜像(pack+publish)。
   */
  buildSteps?: string[];
  /** pack 报 ETARGET/找不到版本时的最大重试次数（应对 gaia 发布后同步到 pack 源的延迟），默认 12 */
  packRetries?: number;
  /** 每次 pack 重试的间隔(ms)，默认 5000 */
  packRetryDelayMs?: number;
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

/** 转义字符串中的正则元字符，用于构造精确匹配的成功行正则 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 简单的延时 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 判断 npm pack 输出是否为“版本尚未就绪”（发布后源未同步），而非真实错误 */
function isVersionNotReady(output: string): boolean {
  return /ETARGET|No matching version found|notarget/i.test(output);
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
    const message = `确认对 ${targets.length} 个组件执行 ${full ? '构建+pack+publish' : 'pack+publish'}?`;
    const confirmed = opts.confirm ? await opts.confirm(message) : false;
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

    // pack：npm 从 pack 源拉取刚发布的版本。gaia 发布后同步到 pack 源可能有延迟，
    // 若报 ETARGET/找不到版本，则等待后重试若干次（默认约 60s），避免“发得太快查不到”直接失败。
    logger.info(
      '  ' + chalk.dim('$ ') + chalk.cyan(`npm pack ${spec} --registry=${opts.packRegistry}`) + chalk.dim(`  (cwd: ${workDir})`)
    );
    const maxRetries = opts.packRetries ?? 12;
    const retryDelayMs = opts.packRetryDelayMs ?? 5000;
    let packRes = await runCommandStream('npm', ['pack', spec, `--registry=${opts.packRegistry}`], { cwd: workDir });
    let retried = 0;
    while (!packRes.ok && retried < maxRetries && isVersionNotReady(packRes.stdout + packRes.stderr)) {
      retried++;
      logger.warn(
        `  pack 暂未取到 ${spec}（发布后 pack 源同步可能有延迟），${Math.round(retryDelayMs / 1000)}s 后重试 ${retried}/${maxRetries}…`
      );
      await sleep(retryDelayMs);
      packRes = await runCommandStream('npm', ['pack', spec, `--registry=${opts.packRegistry}`], { cwd: workDir });
    }
    if (!packRes.ok) {
      const reason = isVersionNotReady(packRes.stdout + packRes.stderr)
        ? `pack 失败: 重试 ${maxRetries} 次后 pack 源仍未可取到该版本（可能同步较慢，稍后重试或用 --pack-wait/--pack-retries 加长等待）`
        : `pack 失败: exit ${packRes.code}`;
      results.push({ component: c.name, spec, ok: false, reason });
      logger.error(`  ${reason}`);
      continue;
    }
    const tgzPath = resolveTgzPath(workDir, expectedTgzName(c.pkgName!, c.pkgVersion!));
    if (!tgzPath) {
      results.push({ component: c.name, spec, ok: false, reason: 'pack 产出的 tgz 未找到' });
      logger.error('  pack 产出的 tgz 未找到（磁盘无匹配文件）');
      continue;
    }

    // publish：流式执行，实时转发输出；npm 发布到私有源(Nexus)常在上传成功后
    // 因保持连接不退出而卡死，这里在确认成功/长时间无输出后主动结束子进程，避免整体挂起。
    logger.info(
      '  ' + chalk.dim('$ ') + chalk.cyan(`npm publish ${path.basename(tgzPath)} --registry=${opts.publishRegistry}`)
    );
    const successRe = new RegExp(`\\+\\s+${escapeRegExp(spec)}`);
    const pubRes = await runCommandStream(
      'npm',
      ['publish', tgzPath, `--registry=${opts.publishRegistry}`],
      {
        cwd: workDir,
        successPattern: successRe,
        idleAfter: { pattern: /Publishing to /, idleMs: 45000 },
      }
    );

    // 清理 tgz（无论 publish 成功与否）
    try {
      fs.rmSync(tgzPath, { force: true });
    } catch {
      /* ignore */
    }

    // 子进程非正常退出且未被我们主动结束 → 真实失败
    if (!pubRes.ok && !pubRes.settledEarly) {
      results.push({ component: c.name, spec, ok: false, reason: `publish 失败: exit ${pubRes.code}` });
      logger.error(`  publish 失败（exit ${pubRes.code}），请检查上方 npm 输出`);
      continue;
    }

    // 看到成功行(+ pkg@version) → 确定成功
    if (pubRes.sawSuccess) {
      results.push({ component: c.name, spec, ok: true });
      if (pubRes.settledEarly) logger.info(chalk.dim('  npm 发布成功后未自行退出（私有源保持连接），已自动结束该子进程'));
      logger.success(`  完成 ${spec}`);
      continue;
    }

    // 未见成功行但被看门狗结束 → 用 npm view 到发布源核对是否真的发上去了
    logger.info(chalk.dim('  npm 未打印成功行，正在向发布源核对是否已发布…'));
    const view = runCommand(
      'npm',
      ['view', spec, 'version', `--registry=${opts.publishRegistry}`],
      { cwd: workDir, timeout: 20000 }
    );
    if (view.stdout.includes(c.pkgVersion!)) {
      results.push({ component: c.name, spec, ok: true });
      logger.success(`  完成 ${spec}（已在发布源核对到该版本）`);
    } else {
      results.push({ component: c.name, spec, ok: false, reason: 'publish 结果未确认（发布源未核对到该版本）' });
      logger.warn('  publish 结果未确认：发布源暂未查到该版本，请稍后到 Nexus 核对或重试');
    }
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
