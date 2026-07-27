import inquirer from 'inquirer';
import { chalk, logger } from '../../utils/logger';
import { SejuaniConfig } from '../../core/config';
import { getRegistryOverride, setRegistry, clearRegistryOverride } from '../../core/state/registryOverrides';

/** registry 设置：按当前域分别设置 pack / publish（持久化，供 release·sync 使用） */
export async function flowRegistry(config: SejuaniConfig): Promise<void> {
  const domain = config.activeDomain;
  const base = config.domains[domain].registries;
  const showCurrent = () => {
    const ov = getRegistryOverride(domain) ?? {};
    logger.info(chalk.dim(`当前域 ${domain}：`));
    logger.info(`  pack    ${ov.pack ? chalk.green('[已设置] ') : chalk.dim('[域默认] ')}${chalk.cyan(ov.pack ?? base.pack)}`);
    logger.info(`  publish ${ov.publish ? chalk.green('[已设置] ') : chalk.dim('[域默认] ')}${chalk.cyan(ov.publish ?? base.publish)}`);
  };
  showCurrent();

  const { op } = await inquirer.prompt<{ op: 'pack' | 'publish' | 'both' | 'reset' | 'back' }>([
    {
      type: 'list',
      name: 'op',
      message: '设置项:',
      choices: [
        { name: '设置 pack（拉取源）', value: 'pack' },
        { name: '设置 publish（发布目标）', value: 'publish' },
        { name: '同时设置 pack 与 publish', value: 'both' },
        { name: '重置为域默认', value: 'reset' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);
  if (op === 'back') return;
  if (op === 'reset') {
    if (clearRegistryOverride(domain)) logger.success(`已重置域 ${chalk.bold(domain)} 的 registry 为默认`);
    else logger.warn(`域 ${domain} 未设置过 registry 覆盖`);
    return;
  }
  const ov = getRegistryOverride(domain) ?? {};
  if (op === 'pack' || op === 'both') {
    const { pack } = await inquirer.prompt<{ pack: string }>([
      { type: 'input', name: 'pack', message: 'pack registry:', default: ov.pack ?? base.pack, filter: (v: string) => v.trim() },
    ]);
    setRegistry(domain, { pack });
  }
  if (op === 'publish' || op === 'both') {
    const { publish } = await inquirer.prompt<{ publish: string }>([
      { type: 'input', name: 'publish', message: 'publish registry:', default: ov.publish ?? base.publish, filter: (v: string) => v.trim() },
    ]);
    setRegistry(domain, { publish });
  }
  logger.success(`已保存域 ${chalk.bold(domain)} 的 registry 设置。`);
  showCurrent();
}
