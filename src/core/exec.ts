import { spawnSync } from 'child_process';
import { chalk, logger } from '../utils/logger';

export interface RunCommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  /** 仅打印命令不执行 */
  dryRun?: boolean;
  /** 传给子进程的环境变量 */
  env?: NodeJS.ProcessEnv;
}

/** 拼接可读命令行（仅用于打印） */
export function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].join(' ');
}

/**
 * 执行一条命令并捕获输出。dryRun 时只打印不执行。
 */
export function runCommand(
  cmd: string,
  args: string[],
  opts: RunCommandOptions = {}
): RunCommandResult {
  const line = formatCommand(cmd, args);
  if (opts.dryRun) {
    logger.info('  ' + chalk.dim('$ ') + chalk.cyan(line));
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }

  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}
