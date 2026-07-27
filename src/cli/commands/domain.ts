import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/config';
import { SejuaniConfig } from '../../core/config';
import { setActiveDomain } from '../../core/state/domain';
import {
  getRegistryOverride,
  setRegistry,
  clearRegistryOverride,
  registryStateFilePath,
} from '../../core/state/registryOverrides';

function printDomains(config: SejuaniConfig): void {
  logger.info(chalk.bold('可用域:'));
  for (const [key, d] of Object.entries(config.domains)) {
    const active = key === config.activeDomain;
    const mark = active ? chalk.green('● 当前') : chalk.dim('○    ');
    logger.info(`  ${mark} ${chalk.bold(key)}  ${chalk.dim(d.label)}`);
    logger.info(chalk.dim(`         工程 ${d.roots.projects.root}`));
    logger.info(chalk.dim(`         组件 ${d.roots.components.root}`));
  }
  logger.info(chalk.dim('\n切换: sjn domain <name>   例: sjn domain foton'));
}

/** 打印某域生效的 pack/publish（含来源标注）。 */
function printRegistryConfig(domain: string, config: SejuaniConfig): void {
  const base = config.domains[domain].registries;
  const override = getRegistryOverride(domain) ?? {};
  const packSrc = override.pack ? chalk.green('[已设置]') : chalk.dim('[域默认]');
  const pubSrc = override.publish ? chalk.green('[已设置]') : chalk.dim('[域默认]');
  const pack = override.pack ?? base.pack;
  const publish = override.publish ?? base.publish;
  logger.title(`registry 设置·域 ${domain}（${config.domains[domain].label}）`);
  logger.info(`  pack    ${packSrc}  ${chalk.cyan(pack)}`);
  logger.info(`  publish ${pubSrc}  ${chalk.cyan(publish)}`);
  logger.info(
    chalk.dim(
      '\n设置: sjn registry set-pack <url> / set-publish <url>   重置: sjn registry reset'
    )
  );
  logger.info(chalk.dim(`存储: ${registryStateFilePath()}`));
}

/** registry 子命令分发：show / set-pack / set-publish / reset */
function handleRegistry(
  action: string | undefined,
  url: string | undefined,
  domain: string,
  config: SejuaniConfig
): void {
  if (!action || action === 'show' || action === 'list' || action === 'ls') {
    printRegistryConfig(domain, config);
    return;
  }
  if (action === 'set-pack' || action === 'pack') {
    if (!url) {
      logger.error('用法: sjn registry set-pack <url>');
      process.exitCode = 1;
      return;
    }
    setRegistry(domain, { pack: url.trim() });
    logger.success(`已设置域 ${chalk.bold(domain)} 的 pack registry = ${chalk.cyan(url.trim())}`);
    return;
  }
  if (action === 'set-publish' || action === 'publish') {
    if (!url) {
      logger.error('用法: sjn registry set-publish <url>');
      process.exitCode = 1;
      return;
    }
    setRegistry(domain, { publish: url.trim() });
    logger.success(`已设置域 ${chalk.bold(domain)} 的 publish registry = ${chalk.cyan(url.trim())}`);
    return;
  }
  if (action === 'reset' || action === 'clear' || action === 'rm') {
    if (clearRegistryOverride(domain)) logger.success(`已重置域 ${chalk.bold(domain)} 的 registry 为配置/内置默认`);
    else logger.warn(`域 ${domain} 未设置过 registry 覆盖`);
    return;
  }
  logger.error(`未知操作: ${action}。可用: show / set-pack / set-publish / reset`);
  process.exitCode = 1;
}

/** 域设置与 registry 地址设置命令。 */
export function register(program: Command): void {
  // 域设置：查看 / 切换 chery|foton|saas
  program
    .command('domain [name]')
    .description('查看或切换域（chery/foton/saas）；切换后影响工程/组件仓库与 registry')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .action((name: string | undefined, opts) => {
      const config = loadConfig(opts.config);
      if (!name) {
        printDomains(config);
        return;
      }
      if (!config.domains[name]) {
        logger.error(`未知域: ${name}。可选: ${Object.keys(config.domains).join(' / ')}`);
        process.exitCode = 1;
        return;
      }
      setActiveDomain(name);
      const d = config.domains[name];
      logger.success(`已切换到域 ${chalk.bold(name)}（${d.label}）`);
      logger.info(chalk.dim(`  工程根: ${d.roots.projects.root}`));
      logger.info(chalk.dim(`  组件库: ${d.roots.components.root}`));
    });

  // registry 地址设置：按域持久化 pack / publish（供 release·sync 使用）
  program
    .command('registry [action] [url]')
    .description('设置/查看 release·sync 使用的 pack/publish registry（按域持久化到 state.json）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-D, --domain <key>', '目标域（默认当前域）')
    .action((action: string | undefined, url: string | undefined, opts) => {
      const config = loadConfig(opts.config);
      const domain = opts.domain ?? config.activeDomain;
      if (!config.domains[domain]) {
        logger.error(`未知域: ${domain}。可选: ${Object.keys(config.domains).join(' / ')}`);
        process.exitCode = 1;
        return;
      }
      handleRegistry(action, url, domain, config);
    });
}
