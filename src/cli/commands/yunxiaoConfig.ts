import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import {
  getYunxiaoConfig,
  setYunxiaoConfig,
  maskToken,
  yunxiaoStateFilePath,
} from '../../core/yunxiaoConfig';
import { listCoders, setActiveCoder, isCoderTool, CODER_TOOLS } from '../../core/coderConfig';

/**
 * 云效接入配置：show / set-token / set-org / set-endpoint / set-project / set-coder。
 * token 展示时打码；set-coder 设置默认本地 AI 编码工具。
 */
function handleConfig(action: string | undefined, value: string | undefined): void {
  const act = (action ?? 'show').toLowerCase();
  if (act === 'show') {
    const cfg = getYunxiaoConfig();
    logger.section('云效接入配置');
    logger.keyValue([
      ['endpoint', chalk.cyan(cfg.endpoint)],
      ['organizationId', cfg.organizationId ? chalk.cyan(cfg.organizationId) : chalk.red('(未设置)')],
      ['token', cfg.personalAccessToken ? chalk.green(maskToken(cfg.personalAccessToken)) : chalk.red('(未设置)')],
      ['defaultProjectId', cfg.defaultProjectId ? chalk.cyan(cfg.defaultProjectId) : chalk.dim('(未设置)')],
    ]);
    logger.section('本地 AI 编码工具');
    logger.table(
      ['工具', '命令', '默认'],
      listCoders().map((c) => [c.tool, c.command, c.active ? chalk.green('✔') : chalk.dim('-')])
    );
    logger.hint(`\n配置文件: ${yunxiaoStateFilePath()}`);
    if (!cfg.personalAccessToken || !cfg.organizationId) {
      logger.warn('尚未完成配置：sjn yunxiao-config set-token <token> 与 set-org <组织id>。');
    }
    return;
  }
  if (!value) {
    logger.error(`操作 ${act} 需要一个值。例如: sjn yunxiao-config ${act} <值>`);
    process.exitCode = 1;
    return;
  }
  switch (act) {
    case 'set-token':
      setYunxiaoConfig({ personalAccessToken: value });
      logger.success(`已设置 token: ${maskToken(value)}`);
      return;
    case 'set-org':
      setYunxiaoConfig({ organizationId: value });
      logger.success(`已设置 organizationId: ${value}`);
      return;
    case 'set-endpoint':
      setYunxiaoConfig({ endpoint: value });
      logger.success(`已设置 endpoint: ${value}`);
      return;
    case 'set-project':
      setYunxiaoConfig({ defaultProjectId: value });
      logger.success(`已设置 defaultProjectId: ${value}`);
      return;
    case 'set-coder':
      if (!isCoderTool(value)) {
        logger.error(`未知编码工具: ${value}。可用: ${CODER_TOOLS.join(' / ')}`);
        process.exitCode = 1;
        return;
      }
      setActiveCoder(value);
      logger.success(`已设置默认编码工具: ${value}`);
      return;
    default:
      logger.error(
        `未知操作: ${action}。可用: show / set-token <t> / set-org <id> / set-endpoint <url> / set-project <id> / set-coder <${CODER_TOOLS.join('|')}>`
      );
      process.exitCode = 1;
  }
}

/** 注册 yunxiao-config 命令。 */
export function register(program: Command): void {
  program
    .command('yunxiao-config [action] [value]')
    .alias('yxcfg')
    .description('云效接入配置：show | set-token <t> | set-org <id> | set-endpoint <url> | set-project <id> | set-coder <tool>')
    .action((action: string | undefined, value: string | undefined) => {
      handleConfig(action, value);
    });
}
