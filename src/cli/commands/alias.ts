import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { getAliases, setAlias, removeAlias, aliasStateFilePath } from '../../core/state/aliases';

function printAliases(): void {
  const aliases = getAliases();
  const names = Object.keys(aliases).sort();
  logger.title('自定义短链');
  if (names.length === 0) {
    logger.info(chalk.dim('  (暂无) 用 sjn alias set <名> "<命令>" 添加，例: sjn alias set r "release --no-build"'));
  } else {
    for (const n of names) {
      logger.info(`  ${chalk.bold(n)}  ${chalk.dim('→')}  sjn ${chalk.cyan(aliases[n])}`);
    }
  }
  logger.info(chalk.dim(`\n存储: ${aliasStateFilePath()}`));
}

/** 自定义短链(alias) 命令。 */
export function register(program: Command): void {
  program
    .command('alias [action] [name] [command]')
    .description('自定义短链：alias set <名> "<命令>" / alias rm <名> / alias（查看列表）')
    .allowUnknownOption(true)
    .action((action: string | undefined, name: string | undefined, command: string | undefined) => {
      if (!action || action === 'list' || action === 'ls') {
        printAliases();
        return;
      }
      if (action === 'set' || action === 'add') {
        if (!name || !command) {
          logger.error('用法: sjn alias set <名称> "<完整命令>"，例: sjn alias set r "release --no-build"');
          process.exitCode = 1;
          return;
        }
        // 内置命令名保留：在此闭包内读取 program.commands，避免反向依赖启动器
        const reserved = new Set(program.commands.map((c) => c.name()));
        if (reserved.has(name)) {
          logger.error(`"${name}" 是内置命令，不能用作短链名。`);
          process.exitCode = 1;
          return;
        }
        setAlias(name, command.trim());
        logger.success(`已设置短链 ${chalk.bold(name)} = ${chalk.cyan(command.trim())}`);
        logger.info(chalk.dim(`现在可用: sjn ${name} [额外参数]`));
        return;
      }
      if (action === 'rm' || action === 'remove' || action === 'del') {
        if (!name) {
          logger.error('用法: sjn alias rm <名称>');
          process.exitCode = 1;
          return;
        }
        if (removeAlias(name)) logger.success(`已删除短链 ${chalk.bold(name)}`);
        else logger.warn(`短链不存在: ${name}`);
        return;
      }
      logger.error(`未知操作: ${action}。可用: list / set / rm`);
      process.exitCode = 1;
    });
}
