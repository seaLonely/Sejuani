import { Command } from 'commander';
import { runWizard } from '../../ui/wizard';

/** start（默认命令）：启动交互式向导。 */
export function register(program: Command): void {
  program
    .command('start', { isDefault: true })
    .description('启动交互式向导（默认命令，默认直进「批量编辑」）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-a, --all', '展示全部功能分类（不直接进入默认分类）')
    .option('-w, --work', '直接进入「AI / 云效协作」（工作/云效）')
    .action(async (opts) => {
      const entry = opts.all ? 'all' : opts.work ? 'ai' : 'batch';
      await runWizard(opts.config, entry);
    });
}
