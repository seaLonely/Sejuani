import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import {
  getMcpConfig,
  setMcpServer,
  removeMcpServer,
  getMcpServerSpec,
  setNotionConfig,
  getNotionConfig,
  mcpStateFilePath,
} from '../../core/state/mcpConfig';
import { withMcpSession } from '../../core/mcp/client';

/**
 * sjn mcp：管理外部 MCP 服务器（U5）。
 * sjn notion：绑定 Notion 团队库（server + 4 个 database id）。
 */
export function register(program: Command): void {
  program
    .command('mcp [action] [name] [rest...]')
    .description('MCP 服务器：list | add <name> <command> [args...] | rm <name> | tools <name>')
    .action(async (action: string | undefined, name: string | undefined, rest: string[] = []) => {
      const act = (action ?? 'list').toLowerCase();
      if (act === 'list') {
        const servers = getMcpConfig().servers ?? {};
        const keys = Object.keys(servers);
        logger.title(`MCP 服务器（${keys.length}）`);
        if (keys.length === 0) logger.info(chalk.dim('  暂无。sjn mcp add <name> <command> [args...] 添加。'));
        for (const k of keys) logger.info(`  ${chalk.bold(k)}: ${servers[k].command} ${(servers[k].args ?? []).join(' ')}`);
        logger.info(chalk.dim(`\n配置文件: ${mcpStateFilePath()}`));
        return;
      }
      if (act === 'add') {
        if (!name || rest.length === 0) { logger.error('用法: sjn mcp add <name> <command> [args...]'); process.exitCode = 1; return; }
        setMcpServer(name, { command: rest[0], args: rest.slice(1) });
        logger.success(`已添加 MCP 服务器 ${chalk.bold(name)}: ${rest.join(' ')}`);
        return;
      }
      if (act === 'rm' || act === 'remove') {
        if (!name) { logger.error('用法: sjn mcp rm <name>'); process.exitCode = 1; return; }
        logger.info(removeMcpServer(name) ? `已删除 ${name}` : `不存在: ${name}`);
        return;
      }
      if (act === 'tools') {
        if (!name) { logger.error('用法: sjn mcp tools <name>'); process.exitCode = 1; return; }
        const spec = getMcpServerSpec(name);
        if (!spec) { logger.error(`未配置服务器: ${name}`); process.exitCode = 1; return; }
        try {
          const tools = await withMcpSession(spec, (s) => s.listTools());
          logger.title(`${name} 工具（${tools.length}）`);
          for (const t of tools) logger.info(`  ${chalk.bold(t.name)}: ${chalk.dim(t.description ?? '')}`);
        } catch (err) {
          logger.error(`连接失败: ${(err as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      logger.error(`未知操作: ${action}。可用: list | add | rm | tools`);
      process.exitCode = 1;
    });

  program
    .command('notion [action] [a] [b]')
    .description('Notion 团队库：show | set-server <mcpName> | set-db <requirements|skills|workflows|runs> <dbId>')
    .action((action: string | undefined, a: string | undefined, b: string | undefined) => {
      const act = (action ?? 'show').toLowerCase();
      if (act === 'show') {
        const n = getNotionConfig();
        logger.title('Notion 团队库配置');
        logger.info(`  MCP 服务器: ${n.server ?? chalk.dim('未绑定')}`);
        logger.info(`  requirements: ${n.db?.requirements ?? chalk.dim('未设')}`);
        logger.info(`  skills: ${n.db?.skills ?? chalk.dim('未设')}`);
        logger.info(`  workflows: ${n.db?.workflows ?? chalk.dim('未设')}`);
        logger.info(`  runs: ${n.db?.runs ?? chalk.dim('未设')}`);
        logger.info(chalk.dim('\n先 sjn mcp add <name> 配置 Notion MCP 服务器，再 set-server 绑定。'));
        return;
      }
      if (act === 'set-server') {
        if (!a) { logger.error('用法: sjn notion set-server <mcpName>'); process.exitCode = 1; return; }
        setNotionConfig({ server: a });
        logger.success(`已绑定 Notion MCP 服务器: ${a}`);
        return;
      }
      if (act === 'set-db') {
        const keys = ['requirements', 'skills', 'workflows', 'runs'];
        if (!a || !b || !keys.includes(a)) { logger.error(`用法: sjn notion set-db <${keys.join('|')}> <dbId>`); process.exitCode = 1; return; }
        setNotionConfig({ db: { [a]: b } });
        logger.success(`已设置 ${a} 数据库 id`);
        return;
      }
      logger.error(`未知操作: ${action}。可用: show | set-server | set-db`);
      process.exitCode = 1;
    });
}
