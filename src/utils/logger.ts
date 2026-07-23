import chalk from 'chalk';

export const logger = {
  info(msg: string): void {
    console.log(msg);
  },
  step(msg: string): void {
    console.log(chalk.cyan('▸ ') + msg);
  },
  success(msg: string): void {
    console.log(chalk.green('✔ ') + msg);
  },
  warn(msg: string): void {
    console.log(chalk.yellow('⚠ ') + msg);
  },
  error(msg: string): void {
    console.error(chalk.red('✖ ') + msg);
  },
  title(msg: string): void {
    console.log('\n' + chalk.bold.magenta(msg));
  },
  dim(msg: string): void {
    console.log(chalk.dim(msg));
  },
};

export { chalk };
