#!/usr/bin/env node
import { logger } from './utils/logger';
import { expandAlias } from './core/aliasStore';
import { buildProgram } from './cli/program';
import { registerAll } from './cli/commands';

const program = buildProgram();
registerAll(program);

// 先展开自定义短链（若首个参数命中且非内置命令），再交给 commander 解析
const reservedCommands = new Set(program.commands.map((c) => c.name()));
const expandedArgs = expandAlias(process.argv.slice(2), reservedCommands);
program
  .parseAsync([process.argv[0], process.argv[1], ...expandedArgs])
  .then(() => {
    // 部分子命令（如 release/sync）以 inherit 方式跑 npm pack/publish，
    // 子进程会共享父进程的 TTY stdin；退出后该 stdin 句柄仍被引用，
    // 使事件循环无法自然排空导致命令跑完不退出。这里显式退出（保留已设置的 exitCode）。
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
