import { Command } from 'commander';
import { readPkgVersion } from '../utils/pkgVersion';
import { expandAlias } from '../core/state/aliases';
import { HELP_BANNER, HELP_AFTER } from './helpText';

/**
 * 先展开自定义短链（若首个参数命中且非内置命令），再交给 commander 解析。
 * 返回展开后的命令行参数（不含 node/脚本路径两项）。
 */
export function expandArgv(program: Command, rawArgs: string[]): string[] {
  const reservedCommands = new Set(program.commands.map((c) => c.name()));
  return expandAlias(rawArgs, reservedCommands);
}

/**
 * 创建并配置顶层 Command：设置 name/description/version 与帮助文案。
 * 命令注册由 cli/commands/index.ts 的 registerAll 完成。
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('sejuani')
    .description(
      '批量管理前端工程 / 组件（projects & components）的 package.json / yarn.lock、仓同步与依赖治理的终端工具 (别名: sjn)'
    )
    .version(readPkgVersion());

  // Feature F - 顶层帮助：前置 banner + 后置分组总览/全局选项/示例
  program.addHelpText('beforeAll', HELP_BANNER);
  program.addHelpText('after', HELP_AFTER);

  return program;
}
