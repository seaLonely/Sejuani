import { spawn, spawnSync } from 'child_process';
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
  /** 直接透传子进程 stdio（用于 yarn/gaia 等长时间构建命令，实时输出） */
  inherit?: boolean;
  /** 超时(ms)：超时后杀掉子进程并返回已捕获的输出（用于可能因私有源保持连接而卡住的命令） */
  timeout?: number;
}

export interface StreamRunResult extends RunCommandResult {
  /** 命中成功/卡死信号后由我们主动结束（子进程未自行退出） */
  settledEarly: boolean;
  /** 输出中命中过 successPattern（可据此确定成功，无需再核对） */
  sawSuccess: boolean;
}

export interface StreamRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 命中该正则即视为成功；随后给子进程一个宽限期自行退出，超时则强制结束 */
  successPattern?: RegExp;
  /** 命中 successPattern 后等待子进程自行退出的宽限(ms)，默认 3000 */
  graceMs?: number;
  /**
   * 卡死看门狗：输出命中 pattern（如“Publishing to”）后开始计时，
   * 每有新输出就重置；持续 idleMs 无输出则判定子进程卡死（私有源保持连接），强制结束。
   */
  idleAfter?: { pattern: RegExp; idleMs: number };
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
    stdio: opts.inherit ? 'inherit' : 'pipe',
    timeout: opts.timeout,
    killSignal: 'SIGKILL',
  });

  return {
    ok: res.status === 0,
    code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * 以异步方式执行命令，实时转发输出，并在必要时避免子进程卡死：
 * - stdin 继承父进程（保留私有仓交互认证的可能）；stdout/stderr 捕获并实时转发。
 * - 命中 successPattern：确认成功，给宽限期让子进程自行退出，超时则强制结束。
 * - idleAfter：命中触发词后长时间无输出，判定卡死（私有源保持连接），强制结束。
 * 用于 npm publish 这类“上传成功但客户端不退出”的场景。
 */
export function runCommandStream(
  cmd: string,
  args: string[],
  opts: StreamRunOptions = {}
): Promise<StreamRunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let settledEarly = false;
    let sawSuccess = false;
    let idleArmed = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let graceTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (graceTimer) clearTimeout(graceTimer);
    };
    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1500);
      t.unref();
    };
    const settle = (res: StreamRunResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      try {
        child.stdout?.removeAllListeners('data');
        child.stderr?.removeAllListeners('data');
      } catch {
        /* ignore */
      }
      resolve(res);
    };

    const armIdle = () => {
      if (!opts.idleAfter) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        const hay = stdout + stderr;
        const looksFailed = /npm ERR!|code E\d|401 Unauthorized|403 Forbidden|EPUBLISHCONFLICT/i.test(hay);
        settledEarly = true;
        killChild();
        settle({ ok: !looksFailed, code: looksFailed ? 1 : 0, stdout, stderr, settledEarly: true, sawSuccess });
      }, opts.idleAfter.idleMs);
    };

    const onChunk = (buf: Buffer, isErr: boolean) => {
      if (isErr) {
        stderr += buf.toString();
        process.stderr.write(buf);
      } else {
        stdout += buf.toString();
        process.stdout.write(buf);
      }
      const hay = stdout + stderr;
      if (!sawSuccess && opts.successPattern && opts.successPattern.test(hay)) {
        sawSuccess = true;
        if (!graceTimer) {
          graceTimer = setTimeout(() => {
            settledEarly = true;
            killChild();
            settle({ ok: true, code: 0, stdout, stderr, settledEarly: true, sawSuccess: true });
          }, opts.graceMs ?? 3000);
        }
      }
      if (opts.idleAfter) {
        if (!idleArmed && opts.idleAfter.pattern.test(hay)) idleArmed = true;
        if (idleArmed) armIdle();
      }
    };

    child.stdout?.on('data', (d: Buffer) => onChunk(d, false));
    child.stderr?.on('data', (d: Buffer) => onChunk(d, true));
    child.on('error', (err) =>
      settle({ ok: false, code: null, stdout, stderr: stderr + String(err), settledEarly: false, sawSuccess })
    );
    child.on('close', (code) =>
      settle({ ok: sawSuccess || code === 0, code: code ?? null, stdout, stderr, settledEarly, sawSuccess })
    );
  });
}
