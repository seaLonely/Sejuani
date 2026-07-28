import { Command } from 'commander';
import { runWizard } from '../../ui/wizard';

/** cli / start：启动交互式向导（非默认；默认入口已改为 agent 对话）。 */
export function register(program: Command): void {
  program
    .command('cli')
    .alias('start')
    .description('启动交互式向导（批量编辑/依赖/任务看板等全部功能）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-a, --all', '展示全部功能分类（不直接进入默认分类）')
    .option('-w, --work', '直接进入「任务看板」（云效工单）')
    .action(async (opts) => {
      const entry = opts.all ? 'all' : opts.work ? 'task' : 'batch';
      await runWizard(opts.config, entry);
    });
}
