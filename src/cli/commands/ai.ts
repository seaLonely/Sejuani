import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/config';
import {
  getAiConfig,
  setAiConfig,
  maskApiKey,
  aiStateFilePath,
  listProfiles,
  upsertProfile,
  useProfile,
  removeProfile,
  setRole,
  getRoles,
  AiRole,
} from '../../core/state/aiConfig';
import { runAiFlow } from '../../ui/aiFlow';

const AI_ROLES: AiRole[] = ['chat', 'planner', 'compress', 'agentTask'];

/** profile 子命令：list / add <名> / use <名> / rm <名> */
function handleProfile(sub: string | undefined, name: string | undefined, opts: { base?: string; key?: string; model?: string }): void {
  const s = (sub ?? 'list').toLowerCase();
  if (s === 'list' || s === 'ls') {
    const roles = getRoles();
    logger.title('AI Profiles');
    for (const { name: n, profile, active } of listProfiles()) {
      const mark = active ? chalk.green(' *') : '  ';
      logger.info(`${mark} ${chalk.bold(n)}  ${chalk.dim(`${profile.model} @ ${profile.baseURL}`)}  ${profile.apiKey ? chalk.dim(maskApiKey(profile.apiKey)) : chalk.red('(无 key)')}`);
    }
    const bound = AI_ROLES.filter((r) => roles[r]).map((r) => `${r}→${roles[r]}`);
    logger.info(chalk.dim(`\n角色绑定: ${bound.length ? bound.join('  ') : '(全部用 activeProfile)'}`));
    logger.info(chalk.dim(`配置文件: ${aiStateFilePath()}`));
    return;
  }
  if (!name) {
    logger.error(`用法: sjn ai-config profile ${s} <名>`);
    process.exitCode = 1;
    return;
  }
  if (s === 'add') {
    upsertProfile(name, { baseURL: opts.base ?? '', apiKey: opts.key ?? '', model: opts.model ?? '' });
    logger.success(`已保存 profile ${chalk.bold(name)}（用 sjn ai-config profile use ${name} 切换）`);
    return;
  }
  if (s === 'use') {
    try {
      useProfile(name);
      logger.success(`已切换到 profile ${chalk.bold(name)}`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }
  if (s === 'rm' || s === 'remove') {
    try {
      if (removeProfile(name)) logger.success(`已删除 profile ${chalk.bold(name)}`);
      else logger.warn(`profile 不存在: ${name}`);
    } catch (err) {
      logger.error((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }
  logger.error(`未知 profile 操作: ${sub}。可用: list / add <名> / use <名> / rm <名>`);
  process.exitCode = 1;
}

/** role 子命令：role set <角色> <profile> */
function handleRole(sub: string | undefined, role: string | undefined, profileName: string | undefined): void {
  if ((sub ?? '').toLowerCase() !== 'set' || !role) {
    logger.error('用法: sjn ai-config role set <chat|planner|compress|agentTask> <profile>');
    process.exitCode = 1;
    return;
  }
  if (!AI_ROLES.includes(role as AiRole)) {
    logger.error(`未知角色: ${role}。可用: ${AI_ROLES.join(' / ')}`);
    process.exitCode = 1;
    return;
  }
  try {
    setRole(role as AiRole, profileName ?? null);
    logger.success(profileName ? `已绑定 ${role} → ${profileName}` : `已解绑角色 ${role}`);
  } catch (err) {
    logger.error((err as Error).message);
    process.exitCode = 1;
  }
}

/**
 * AI 接入配置：show / set-key / set-base / set-model / profile / role。
 * apiKey 展示时打码。
 */
function handleAiConfig(
  action: string | undefined,
  value: string | undefined,
  arg: string | undefined,
  arg2: string | undefined,
  opts: { base?: string; key?: string; model?: string }
): void {
  const act = (action ?? 'show').toLowerCase();
  if (act === 'profile' || act === 'profiles') {
    handleProfile(value, arg, opts);
    return;
  }
  if (act === 'role') {
    // role set <角色> <profile>：value=set, arg=角色, arg2=profile
    handleRole(value, arg, arg2);
    return;
  }
  if (act === 'show') {
    const cfg = getAiConfig();
    logger.title('AI 接入配置（当前激活 profile）');
    logger.info(`  baseURL     : ${chalk.cyan(cfg.baseURL)}`);
    logger.info(`  model       : ${chalk.cyan(cfg.model)}`);
    logger.info(`  temperature : ${chalk.cyan(String(cfg.temperature))}`);
    logger.info(`  apiKey      : ${cfg.apiKey ? chalk.green(maskApiKey(cfg.apiKey)) : chalk.red('(未设置)')}`);
    logger.info(chalk.dim(`\n多 profile 管理: sjn ai-config profile list`));
    logger.info(chalk.dim(`配置文件: ${aiStateFilePath()}`));
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
      logger.error(`未知操作: ${action}。可用: show / set-key / set-base / set-model / profile / role`);
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

  // AI 配置：show / set-key / set-base / set-model / profile / role
  program
    .command('ai-config [action] [value] [arg] [arg2]')
    .alias('aicfg')
    .description('AI 接入配置：show | set-key/set-base/set-model <v> | profile [list|add|use|rm] | role set <角色> <profile>')
    .option('--base <url>', 'profile add 的 baseURL')
    .option('--key <key>', 'profile add 的 apiKey')
    .option('--model <model>', 'profile add 的 model')
    .action((action: string | undefined, value: string | undefined, arg: string | undefined, arg2: string | undefined, opts) => {
      handleAiConfig(action, value, arg, arg2, opts);
    });
}
