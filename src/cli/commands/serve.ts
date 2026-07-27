import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { loadConfig } from '../../core/config';
import { startServer } from '../../server';
import { startScheduler } from '../../core/workflow/scheduler';

/**
 * 本地 API 服务命令：供 Tauri 桌面前端调用。
 * 绑定 127.0.0.1，默认端口 7758；默认同时启动工作流调度器（--no-scheduler 关闭）。
 */
export function register(program: Command): void {
  program
    .command('serve')
    .description('启动本地 HTTP API 服务（供桌面前端调用，绑定 127.0.0.1），默认携带工作流调度器')
    .option('-c, --config <file>', '指定配置文件')
    .option('-p, --port <port>', '监听端口', (v) => parseInt(v, 10), 7758)
    .option('--no-scheduler', '不启动工作流调度器（仅 HTTP API）')
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      await startServer({ port: opts.port, config });
      logger.success(`Sejuani API 服务已启动: ${chalk.cyan(`http://127.0.0.1:${opts.port}`)}（Ctrl+C 停止）`);
      if (opts.scheduler !== false) {
        startScheduler(config);
      } else {
        logger.info(chalk.dim('已按 --no-scheduler 跳过工作流调度器。'));
      }
      // 常驻：src/index.ts 在 parseAsync 结束后会显式 process.exit，
      // 这里挂起 promise 让进程由 server 句柄维持运行。
      await new Promise<void>(() => {});
    });
}
