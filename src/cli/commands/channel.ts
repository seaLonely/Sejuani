import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import {
  getChannelsConfig,
  setChannelsConfig,
  maskChannelSecret,
  channelStateFilePath,
} from '../../core/state/channelConfig';

/**
 * sjn channel-config：配置飞书/企业微信官方渠道（出站群机器人）。
 * 合规：仅飞书/企业微信官方 API，不支持个人微信。
 */
export function register(program: Command): void {
  program
    .command('channel-config [action] [a] [b]')
    .description('渠道配置：show | feishu <webhookUrl> | wecom <webhookKey>（仅飞书/企业微信官方 API）')
    .action((action: string | undefined, a: string | undefined, _b, ) => {
      const act = (action ?? 'show').toLowerCase();
      if (act === 'show') {
        const c = getChannelsConfig();
        logger.title('渠道配置');
        logger.info(`  飞书 webhook: ${c.feishu?.webhook ? maskChannelSecret(c.feishu.webhook) : chalk.dim('未配置')}`);
        logger.info(`  企微 webhookKey: ${c.wecom?.webhookKey ? maskChannelSecret(c.wecom.webhookKey) : chalk.dim('未配置')}`);
        logger.info(chalk.dim(`\n配置文件: ${channelStateFilePath()}`));
        logger.info(chalk.dim('合规提示：仅支持飞书/企业微信官方 API，不支持个人微信自动化。'));
        return;
      }
      if (act === 'feishu') {
        if (!a) { logger.error('用法: sjn channel-config feishu <webhookUrl>'); process.exitCode = 1; return; }
        setChannelsConfig({ feishu: { webhook: a } });
        logger.success('已设置飞书群机器人 webhook');
        return;
      }
      if (act === 'wecom') {
        if (!a) { logger.error('用法: sjn channel-config wecom <webhookKey>'); process.exitCode = 1; return; }
        setChannelsConfig({ wecom: { webhookKey: a } });
        logger.success('已设置企业微信群机器人 webhookKey');
        return;
      }
      logger.error(`未知操作: ${action}。可用: show | feishu <url> | wecom <key>`);
      process.exitCode = 1;
    });
}
