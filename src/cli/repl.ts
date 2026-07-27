import readline from 'readline';
import { SejuaniConfig } from '../core/config';
import { chalk, logger } from '../utils/logger';
import { aiConfigured, getAiConfig, listProfiles, useProfile } from '../core/state/aiConfig';
import { listMemory, forgetMemory } from '../core/agent/memory';
import { renderTodos } from '../core/agent/todo';
import { inquirerInput, inquirerConfirmEx } from '../ui/prompt';
import { AgentBrain } from '../core/agent/brain';
import { AgentHarness } from '../core/agent/harness';

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

  // goal 模式运行中的 harness（SIGINT 中断链路用）
  let activeHarness: AgentHarness | null = null;

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // 自主执行：/goal <目标> 启动 Harness 循环（共享当前会话 brain）
    if (input.toLowerCase().startsWith('/goal ')) {
      const goal = input.slice(6).trim();
      if (!goal) {
        console.log(chalk.dim('  用法：/goal <目标描述>'));
        rl.prompt();
        return;
      }
      const harness = AgentHarness.fromBrain(brain, {
        onDelta: (t) => process.stdout.write(t),
        onProgress: (e) => {
          if (e.type === 'iteration-start') console.log(chalk.dim(`\n── 迭代 ${e.iteration} ──`));
          else if (e.type === 'todo-update' && e.todos) console.log(chalk.dim('\n' + renderTodos(e.todos)));
          else if (e.type === 'budget-warn' || e.type === 'loop-warn') console.log(chalk.yellow(`\n[${e.type}] ${e.reason ?? ''}`));
        },
      });
      // 中断链路：SIGINT 双击时需停止 harness 外层循环（仅 brain.abort 会继续迭代）
      activeHarness = harness;
      try {
        console.log('');
        const r = await harness.runGoal(goal);
        console.log(chalk.bold(`\n[终局 ${r.outcome}] 迭代 ${r.iterations} 轮。`));
      } catch (err) {
        console.log(chalk.red(`\n[错误] ${(err as Error).message}`));
      } finally {
        activeHarness = null;
      }
      console.log('');
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

  // Ctrl+C：空闲时仅重绘提示符；执行中第一次提示、第二次中断（goal 模式下连同 harness 外层循环一并停止）
  let lastSigint = 0;
  rl.on('SIGINT', () => {
    if (brain.isProcessing() || activeHarness) {
      const now = Date.now();
      if (now - lastSigint < 2000) {
        if (activeHarness) {
          activeHarness.abort(); // 置 harness.aborted + brain.abort，外层循环下轮退出
          console.log(chalk.yellow('\n已发送中断信号，正在停止自主执行…'));
        } else {
          brain.abort();
          console.log(chalk.yellow('\n已发送中断信号，正在停止当前轮…'));
        }
      } else {
        lastSigint = now;
        console.log(chalk.dim('\n执行中。再按一次 Ctrl+C 中断。'));
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

  // /memory：查看/删除长期记忆
  if (cmd === '/memory' || cmd.startsWith('/memory ')) {
    const parts = input.trim().split(/\s+/);
    const sub = parts[1];
    if (sub === 'rm' && parts[2]) {
      const ok = forgetMemory(brain.getDomain(), parts[2]);
      console.log(chalk.dim(ok ? `  已删除记忆 ${parts[2]}` : `  未找到记忆 ${parts[2]}`));
      return;
    }
    const entries = listMemory(brain.getDomain());
    console.log(chalk.bold(`\n长期记忆（域 ${brain.getDomain()}，${entries.length} 条）：`));
    if (entries.length === 0) console.log(chalk.dim('  （暂无）'));
    for (const e of entries) {
      console.log(`  ${chalk.cyan(`[${e.category}]`)} ${e.content} ${chalk.dim(`w${e.weight} #${e.id}`)}`);
    }
    console.log(chalk.dim('  删除：/memory rm <id>\n'));
    return;
  }

  // /model：查看 profile 与当前解析；/model <名> 切换激活 profile
  if (cmd === '/model' || cmd.startsWith('/model ')) {
    const parts = input.trim().split(/\s+/);
    if (parts[1]) {
      try {
        useProfile(parts[1]);
        console.log(chalk.dim(`  已切换到 profile ${parts[1]}（下一轮对话生效）`));
      } catch (err) {
        console.log(chalk.red(`  ${(err as Error).message}`));
      }
      return;
    }
    const cfg = getAiConfig();
    console.log(chalk.bold('\nAI Profiles：'));
    for (const { name, profile, active } of listProfiles()) {
      console.log(`  ${active ? chalk.green('*') : ' '} ${chalk.bold(name)} ${chalk.dim(`${profile.model} @ ${profile.baseURL}`)}`);
    }
    console.log(chalk.dim(`  当前生效：${cfg.model} @ ${cfg.baseURL}\n  切换：/model <名>\n`));
    return;
  }

  // /todos：查看当前任务清单
  if (cmd === '/todos') {
    console.log(chalk.bold('\n任务清单：'));
    console.log(renderTodos(brain.getTodos()));
    console.log('');
    return;
  }

  if (cmd === '/help') {
    console.log(`
${chalk.bold('内置命令：')}
  /tools    展示全部已注册工具
  /stats    会话统计（轮次/工具/token）
  /todos    查看当前任务清单（自主执行中）
  /memory   查看长期记忆（/memory rm <id> 删除）
  /model    查看/切换模型 profile（/model <名>）
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

/**
 * 非交互自主模式（sjn agent --goal）：Harness.runGoal 跑到终局，打印结果后返回。
 * 交互确认仍走 inquirer（在场模式）；双击 Ctrl+C 中断。
 */
export async function runAgentGoal(
  config: SejuaniConfig,
  goal: string,
  opts: ReplOptions = {}
): Promise<void> {
  if (!aiConfigured()) {
    logger.error('尚未配置 AI apiKey。请先执行：sjn ai-config set-key <key>。');
    process.exitCode = 1;
    return;
  }
  const harness = new AgentHarness(config, {
    sessionId: opts.session,
    workDir: process.cwd(),
    memoryDomain: config.activeDomain,
    reportId: opts.session ?? `goal-${Date.now().toString(36)}`,
    onDelta: (t) => process.stdout.write(t),
    onProgress: (e) => {
      if (e.type === 'iteration-start') console.log(chalk.dim(`\n── 迭代 ${e.iteration} ──`));
      else if (e.type === 'todo-update' && e.todos) console.log(chalk.dim('\n' + renderTodos(e.todos)));
      else if (e.type === 'budget-warn' || e.type === 'loop-warn') console.log(chalk.yellow(`\n[${e.type}] ${e.reason ?? ''}`));
    },
  });
  const brain = harness.getBrain();
  brain.setConfirmEx(inquirerConfirmEx);
  brain.setConfirm(async (message) => (await inquirerConfirmEx(message)) !== 'no');
  brain.setPromptInput(inquirerInput);
  brain.setPrint((text) => console.log(text));

  // 双击 Ctrl+C 中断
  let lastSigint = 0;
  const onSigint = (): void => {
    const now = Date.now();
    if (now - lastSigint < 2000) {
      harness.abort();
      console.log(chalk.yellow('\n已发送中断信号…'));
    } else {
      lastSigint = now;
      console.log(chalk.dim('\n自主执行中。再按一次 Ctrl+C 中断。'));
    }
  };
  process.on('SIGINT', onSigint);

  console.log('');
  console.log(chalk.bold.cyan('Sejuani Agent') + chalk.dim(' · 自主目标模式'));
  console.log(chalk.dim(`目标: ${goal}`));
  try {
    const r = await harness.runGoal(goal);
    console.log(chalk.bold(`\n\n── 终局：${r.outcome} ──`));
    console.log(chalk.dim(`迭代 ${r.iterations} 轮 · 工具 ${r.usage.toolCalls} 次 · tokens ${r.usage.promptTokens + r.usage.completionTokens}`));
    if (r.todos.length > 0) console.log(renderTodos(r.todos));
    if (r.reportPath) console.log(chalk.dim(`报告: ${r.reportPath}`));
    if (r.changed && r.changed.length > 0) console.log(chalk.dim(`改动 ${r.changed.length} 文件`));
    if (r.outcome !== 'completed') process.exitCode = 1;
  } catch (err) {
    logger.error(`自主执行失败: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}
