import readline from 'readline';
import inquirer from 'inquirer';
import { SejuaniConfig } from '../../config';
import { chalk, logger } from '../../utils/logger';
import { aiConfigured } from '../aiConfig';
import { AgentBrain } from './brain';
import { getAllTools } from './registry';

/**
 * Agent REPL：交互式对话循环。
 * 用户用自然语言输入，Agent Brain 理解并通过 Function Calling 调度工具执行。
 */

export interface ReplOptions {
  model?: string;
}

export async function startAgentRepl(config: SejuaniConfig, opts: ReplOptions = {}): Promise<void> {
  // 前置检查
  if (!aiConfigured()) {
    logger.error('尚未配置 AI apiKey。请先执行：sjn ai-config set-key <key>（或设置环境变量 OPENAI_API_KEY）。');
    return;
  }

  const brain = new AgentBrain(config, { model: opts.model });

  // 注入确认回调
  brain.setConfirm(async (message: string) => {
    const { ok } = await inquirer.prompt<{ ok: boolean }>([
      { type: 'confirm', name: 'ok', message, default: false },
    ]);
    return ok;
  });

  // 注入输出
  brain.setPrint((text) => console.log(text));

  // 欢迎信息
  const toolCount = brain.getToolCount();
  console.log('');
  console.log(chalk.bold.cyan('Sejuani Agent') + chalk.dim(' · 智能开发助手'));
  console.log(chalk.dim(`域: ${config.activeDomain} · 工具: ${toolCount} 个 · 输入 /help 查看命令`));
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green('sjn> '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // 内置命令
    if (input.startsWith('/')) {
      const handled = handleCommand(input, brain);
      if (handled === 'exit') {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    // 调用 Agent Brain
    try {
      const response = await brain.process(input);
      console.log('');
      console.log(response);
      console.log('');
    } catch (err) {
      console.log(chalk.red(`\n[错误] ${(err as Error).message}\n`));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.dim('\n再见！'));
  });

  // Ctrl+C 不退出 REPL，仅中断当前行
  rl.on('SIGINT', () => {
    console.log('');
    rl.prompt();
  });
}

/** 处理 / 开头的内置命令。返回 'exit' 表示退出 REPL。 */
function handleCommand(input: string, brain: AgentBrain): string | void {
  const cmd = input.toLowerCase();

  if (cmd === '/exit' || cmd === '/quit' || cmd === '/q') {
    return 'exit';
  }

  if (cmd === '/clear') {
    brain.clearHistory();
    console.log(chalk.dim('  对话历史已清除。'));
    return;
  }

  if (cmd === '/tools') {
    const tools = brain.getToolNames();
    console.log(chalk.bold(`\n已注册工具（${tools.length}）：`));
    for (const t of tools) {
      console.log(`  ${chalk.cyan(t.split(':')[0])}${chalk.dim(':' + t.split(':').slice(1).join(':'))}`);
    }
    console.log('');
    return;
  }

  if (cmd === '/help') {
    console.log(`
${chalk.bold('内置命令：')}
  /tools    展示全部已注册工具
  /clear    清除对话历史
  /exit     退出 Agent
  /help     显示本帮助

${chalk.dim('直接输入自然语言即可与 Agent 对话，例如：')}
  ${chalk.dim('• 列出当前迭代的所有工单')}
  ${chalk.dim('• 帮我把 BENZ-5650 流转到待测试')}
  ${chalk.dim('• 扫描组件库，看看有哪些组件')}
  ${chalk.dim('• 检测一下当前 Node 环境')}
`);
    return;
  }

  console.log(chalk.dim(`  未知命令: ${input}。输入 /help 查看可用命令。`));
}
