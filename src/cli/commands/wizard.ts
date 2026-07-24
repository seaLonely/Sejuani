import { Command } from 'commander';
import { runWizard } from '../../ui/wizard';

/** start（默认命令）：启动交互式向导。 */
export function register(program: Command): void {
  program
    .command('start', { isDefault: true })
    .description('启动交互式向导（默认命令）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .action(async (opts) => {
      await runWizard(opts.config);
    });
}
