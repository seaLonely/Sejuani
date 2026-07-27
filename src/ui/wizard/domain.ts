import inquirer from 'inquirer';
import { chalk, logger } from '../../utils/logger';
import { SejuaniConfig } from '../../core/config';
import { setActiveDomain } from '../../core/state/domain';

/** 域设置：展示当前域并切换，返回被选中的域 key */
export async function flowDomain(config: SejuaniConfig): Promise<string> {
  const keys = Object.keys(config.domains);
  const { picked } = await inquirer.prompt<{ picked: string }>([
    {
      type: 'list',
      name: 'picked',
      message: `选择域（当前: ${config.activeDomain}）:`,
      default: config.activeDomain,
      choices: keys.map((k) => ({
        name: `${config.domains[k].label}  ${chalk.dim(config.domains[k].roots.projects.root)}`,
        value: k,
      })),
    },
  ]);
  setActiveDomain(picked);
  logger.success(`已切换到域 ${chalk.bold(picked)}（${config.domains[picked].label}）`);
  return picked;
}
