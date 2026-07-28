import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { loadConfig } from '../../core/config';
import { startAgentRepl, runAgentGoal } from '../repl';
import { chalk, logger } from '../../utils/logger';
import { runEvals, loadCases, BUILTIN_CASES } from '../../core/agent/evals';
import { SEJUANI_MD_TEMPLATE } from '../../core/agent/projectContext';

/**
 * 智能 Agent 对话模式命令。
 * 缺省进入 REPL 循环；--goal 时进入 Harness 非交互自主执行模式。
 */
export function register(program: Command): void {
  program
    .command('agent', { isDefault: true })
    .alias('chat')
    .description('启动智能 Agent 对话（默认入口）；--goal 进入自主执行模式（其余功能请用 sjn cli）')
    .option('-c, --config <file>', '指定配置文件')
    .option('--model <model>', '覆盖 LLM 模型')
    .option('--session <id>', '持久化会话 id（保存历史/统计/审计到 ~/.sejuani/agent-sessions/，重进可恢复）')
    .option('--goal <goal>', '自主目标模式：给定目标自动拆解 todo 并迭代执行直到完成/预算耗尽')
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      if (opts.goal && String(opts.goal).trim()) {
        await runAgentGoal(config, String(opts.goal).trim(), { model: opts.model, session: opts.session });
        return;
      }
      await startAgentRepl(config, { model: opts.model, session: opts.session });
    });

  // sjn agent init：在当前目录生成 SEJUANI.md 项目上下文模板
  program
    .command('agent-init')
    .alias('init')
    .description('在当前目录生成 SEJUANI.md 项目约定模板（会被 Agent 每次对话读取）')
    .option('-f, --force', '已存在时覆盖', false)
    .action((opts) => {
      const target = path.join(process.cwd(), 'SEJUANI.md');
      if (fs.existsSync(target) && !opts.force) {
        logger.warn(`SEJUANI.md 已存在：${target}（用 --force 覆盖）`);
        return;
      }
      fs.writeFileSync(target, SEJUANI_MD_TEMPLATE);
      logger.success(`已生成 ${chalk.bold('SEJUANI.md')} → ${target}`);
    });

  // Evals 基准集回放（R5）：跑一组标准目标并汇总终局，用于改 prompt/模型后量化对比
  program
    .command('eval')
    .description('回放 Agent 基准任务集（Harness）并汇总通过率（--file 自定义用例集）')
    .option('-c, --config <file>', '指定配置文件')
    .option('--file <cases.json>', '自定义 EvalCase JSON 数组文件（缺省用内置集）')
    .action(async (opts) => {
      const config = loadConfig(opts.config);
      const cases = opts.file ? loadCases(opts.file) : BUILTIN_CASES;
      logger.title(`Evals（${cases.length} 用例）`);
      const report = await runEvals(config, cases, (name, outcome) => {
        logger.info(`  ${name}: ${outcome}`);
      });
      logger.title('Evals 结果');
      for (const r of report.results) {
        const tag = r.pass ? chalk.green('PASS') : chalk.red('FAIL');
        logger.info(`  ${tag} ${r.name}  ${chalk.dim(`${r.outcome}(期望 ${r.expected}) · ${r.iterations}轮 · ${r.toolCalls}工具 · ${r.totalTokens}tokens`)}`);
      }
      logger.info(`\n通过 ${report.passed}/${report.total}`);
      if (report.passed < report.total) process.exitCode = 1;
    });
}
