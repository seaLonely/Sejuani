import { chalk } from '../../../utils/logger';
import { runCommand } from '../../exec';
import { StepHandler } from './contract';

/**
 * 通用 shell 步骤：在指定 cwd 执行任意命令。
 * 默认 dangerous（命令内容不可静态判定），preview 完整展示命令与 cwd。
 */

export const shellRun: StepHandler = {
  kind: 'shell.run',
  describe: () => ({
    kind: 'shell.run',
    summary: '在指定目录执行任意 shell 命令（如自定义构建/脚本）。不可静态判定影响，默认危险。',
    params: {
      command: '必填，要执行的命令（如 "yarn lint"）',
      cwd: '可选，工作目录；缺省为当前目录',
      timeoutSec: '可选，超时秒数，默认 300',
    },
    dangerous: true,
  }),
  preview: (step) => {
    const command = String(step.params.command ?? '<command>');
    const cwd = step.params.cwd ? String(step.params.cwd) : process.cwd();
    return [chalk.yellow('⚠ 执行 shell 命令：'), `  $ ${command}`, `  cwd: ${cwd}`];
  },
  execute: async (step) => {
    const command = String(step.params.command ?? '').trim();
    if (!command) return { ok: false, reason: '缺少必填参数 command' };
    const cwd = step.params.cwd ? String(step.params.cwd) : process.cwd();
    const timeoutSec = typeof step.params.timeoutSec === 'number' && step.params.timeoutSec > 0
      ? step.params.timeoutSec
      : 300;
    const [cmd, ...cmdArgs] = command.split(/\s+/);
    const r = runCommand(cmd, cmdArgs, { cwd, timeout: timeoutSec * 1000 });
    if (!r.ok) {
      return { ok: false, reason: `命令失败(exit=${r.code})：${(r.stderr || r.stdout).slice(-300)}` };
    }
    return {
      ok: true,
      reason: `命令执行成功`,
      outputs: { stdoutTail: r.stdout.slice(-500) },
    };
  },
};
