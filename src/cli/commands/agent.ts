import { Command } from 'commander';
import { loadConfig } from '../../core/configLoader';
import { startAgentRepl } from '../../core/agent/repl';

/**
 * 智能 Agent 对话模式命令。
 * 启动后进入 REPL 循环，用户用自然语言描述意图，Agent 自动调度工具执行。
 */
export function register(program: Command): void {
  program
    .command('agent')
    .alias('chat')
    .description('启动智能 Agent 对话模式（自然语言驱动开发工作流）')
    .option('-c, --config <file>', '指定配置文件')
    .option('--model <model>', '覆盖 LLM 模型')
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      await startAgentRepl(config, { model: opts.model });
    });
}
