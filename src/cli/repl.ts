import readline from 'readline';
import { SejuaniConfig } from '../core/config';
import { chalk, logger } from '../utils/logger';
import { aiConfigured } from '../core/state/aiConfig';
import { inquirerInput, inquirerConfirmEx } from '../ui/prompt';
import { AgentBrain } from '../core/agent/brain';

/**
 * Agent REPL：交互式对话循环（流式输出）。
 * 用户用自然语言输入，Agent Brain 理解并通过 Function Calling 调度工具执行。
 * 执行中 Ctrl+C 两次可中断当前轮。
 */

export interface ReplOptions {
  model?: string;
  /** 持久化会话 id：提供时保存历史/统计/审计到 ~/.sejuani/agent-sessions/ 并可恢复 */
  session?: string;
}

export async function startAgentRepl(config: SejuaniConfig, opts: ReplOptions = {}): Promise<void> {
  // 前置检查
  if (!aiConfigured()) {
    logger.error('尚未配置 AI apiKey。请先执行：sjn ai-config set-key <key>（或设置环境变量 OPENAI_API_KEY）。');
    return;
  }

  const brain = new AgentBrain(config, { model: opts.model, sessionId: opts.session, resume: !!opts.session });

  // 注入三态确认（是/否/总是允许）与布尔确认回落
  brain.setConfirmEx(inquirerConfirmEx);
  brain.setConfirm(async (message) => (await inquirerConfirmEx(message)) !== 'no');

  // 注入输入回调（工作流 needsInput 补全）
  brain.setPromptInput(inquirerInput);

  // 注入输出
  brain.setPrint((text) => console.log(text));

  // 欢迎信息
  const toolCount = brain.getToolCount();
  console.log('');
  console.log(chalk.bold.cyan('Sejuani Agent') + chalk.dim(' · 智能开发助手'));
  console.log(chalk.dim(`域: ${config.activeDomain} · 工具: ${toolCount} 个${opts.session ? ` · 会话: ${opts.session}` : ''} · 输入 /help 查看命令`));
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

    // 调用 Agent Brain（流式增量直接写 stdout）
    try {
      console.log('');
      let streamed = false;
      const response = await brain.process(input, {
        onDelta: (text) => {
          streamed = true;
          process.stdout.write(text);
        },
      });
      if (streamed) {
        process.stdout.write('\n');
      } else {
        console.log(response);
      }
      console.log('');
    } catch (err) {
      console.log(chalk.red(`\n[错误] ${(err as Error).message}\n`));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.dim('\n再见！'));
  });

  // Ctrl+C：空闲时仅重绘提示符；执行中第一次提示、第二次中断当前轮
  let lastSigint = 0;
  rl.on('SIGINT', () => {
    if (brain.isProcessing()) {
      const now = Date.now();
      if (now - lastSigint < 2000) {
        brain.abort();
        console.log(chalk.yellow('\n已发送中断信号，正在停止当前轮…'));
      } else {
        lastSigint = now;
        console.log(chalk.dim('\n执行中。再按一次 Ctrl+C 中断当前轮。'));
      }
      return;
    }
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

  if (cmd === '/stats') {
    const s = brain.getStats();
    console.log(`
${chalk.bold('会话统计：')}
  LLM 轮次     : ${s.rounds}
  工具调用     : ${s.toolCalls}
  prompt tokens: ${s.promptTokens}
  输出 tokens  : ${s.completionTokens}
  开始于       : ${s.startedAt}
`);
    return;
  }

  if (cmd === '/help') {
    console.log(`
${chalk.bold('内置命令：')}
  /tools    展示全部已注册工具
  /stats    会话统计（轮次/工具/token）
  /clear    清除对话历史
  /exit     退出 Agent
  /help     显示本帮助

${chalk.dim('直接输入自然语言即可与 Agent 对话，例如：')}
  ${chalk.dim('• 列出当前迭代的所有工单')}
  ${chalk.dim('• 帮我把 BENZ-5650 流转到待测试')}
  ${chalk.dim('• 规划并执行：把 A 组件升级发布并升级使用方')}
  ${chalk.dim('• 检测一下当前 Node 环境')}
`);
    return;
  }

  console.log(chalk.dim(`  未知命令: ${input}。输入 /help 查看可用命令。`));
}
