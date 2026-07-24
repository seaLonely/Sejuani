import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/configLoader';
import { getAiConfig, setAiConfig, maskApiKey, aiStateFilePath } from '../../core/aiConfig';
import { runAiFlow } from '../../ui/aiFlow';

/**
 * AI 接入配置：show / set-key / set-base / set-model。
 * apiKey 展示时打码。
 */
function handleAiConfig(action: string | undefined, value: string | undefined): void {
  const act = (action ?? 'show').toLowerCase();
  if (act === 'show') {
    const cfg = getAiConfig();
    logger.title('AI 接入配置');
    logger.info(`  baseURL     : ${chalk.cyan(cfg.baseURL)}`);
    logger.info(`  model       : ${chalk.cyan(cfg.model)}`);
    logger.info(`  temperature : ${chalk.cyan(String(cfg.temperature))}`);
    logger.info(`  apiKey      : ${cfg.apiKey ? chalk.green(maskApiKey(cfg.apiKey)) : chalk.red('(未设置)')}`);
    logger.info(chalk.dim(`\n配置文件: ${aiStateFilePath()}`));
    if (!cfg.apiKey) {
      logger.warn('尚未设置 apiKey：sjn ai-config set-key <key>（或设置环境变量 OPENAI_API_KEY）。');
    }
    return;
  }
  if (!value) {
    logger.error(`操作 ${act} 需要一个值。例如: sjn ai-config ${act} <值>`);
    process.exitCode = 1;
    return;
  }
  switch (act) {
    case 'set-key':
      setAiConfig({ apiKey: value });
      logger.success(`已设置 apiKey: ${maskApiKey(value)}`);
      return;
    case 'set-base':
      setAiConfig({ baseURL: value });
      logger.success(`已设置 baseURL: ${value}`);
      return;
    case 'set-model':
      setAiConfig({ model: value });
      logger.success(`已设置 model: ${value}`);
      return;
    default:
      logger.error(`未知操作: ${action}。可用: show / set-key <k> / set-base <url> / set-model <m>`);
      process.exitCode = 1;
  }
}

/** AI 工作流入口与 AI 接入配置命令。 */
export function register(program: Command): void {
  // AI 工作流：选组件 + 自然语言描述 → 生成可审阅工作流 → 确认后确定性执行
  program
    .command('ai [description...]')
    .description('AI 工作流：选组件并用自然语言描述，生成可审阅工作流并（确认后）执行')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '选组件的扫描目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）')
    .option('--template <name>', '套用已存模板（不调 AI，按当前选中组件重绑定）')
    .option('--save-template <name>', '把本次生成的工作流存为模板')
    .option('--dry-run', '仅规划并预览工作流，不执行', false)
    .option('-y, --yes', '跳过确认（含危险步骤，慎用）', false)
    .action(async (description: string[] | undefined, opts) => {
      // ai config 子命令走单独命令；这里仅处理工作流
      const config = loadConfig(opts.config);
      await runAiFlow(config, {
        dir: opts.dir,
        components: opts.components,
        description: description && description.length ? description.join(' ') : undefined,
        template: opts.template,
        saveTemplate: opts.saveTemplate,
        dryRun: opts.dryRun,
        yes: opts.yes,
      });
    });

  // AI 配置：show / set-key / set-base / set-model
  program
    .command('ai-config [action] [value]')
    .alias('aicfg')
    .description('AI 接入配置：ai-config show | set-key <k> | set-base <url> | set-model <m>')
    .action((action: string | undefined, value: string | undefined) => {
      handleAiConfig(action, value);
    });
}
