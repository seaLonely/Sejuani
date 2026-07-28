import readline from 'readline';
import { SejuaniConfig } from '../core/config';
import { chalk, logger } from '../utils/logger';
import { aiConfigured, getAiConfig, listProfiles, useProfile } from '../core/state/aiConfig';
import { listMemory, forgetMemory } from '../core/agent/memory';
import { renderTodos } from '../core/agent/todo';
import { inquirerInput, inquirerConfirmEx, inquirerConfirm } from '../ui/prompt';
import { AgentBrain } from '../core/agent/brain';
import { AgentHarness } from '../core/agent/harness';
import { listSkills, saveSkill, loadSkill } from '../core/skill/store';
import { draftSkillFromHistory } from '../core/skill/creator';
import { runSkill } from '../core/skill/run';
import { reflectUserProfile, saveProfileFacts } from '../core/agent/profileReflect';
import { renderMarkdown } from '../utils/markdown';
import { startSpinner, Spinner } from '../utils/spinner';

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

/** 内置 slash 命令清单（名称 + 一行说明），用于 Tab 补全与输入 / 时的提示 */
const SLASH_COMMANDS: Array<{ cmd: string; desc: string }> = [
  { cmd: '/goal', desc: '自主执行：/goal <目标>' },
  { cmd: '/skill', desc: '技能：list 列出 / save [名] 固化当前会话' },
  { cmd: '/profile', desc: '从会话反思并更新用户画像' },
  { cmd: '/tools', desc: '展示已注册工具' },
  { cmd: '/todos', desc: '查看当前任务清单' },
  { cmd: '/memory', desc: '查看长期记忆（rm <id> 删除）' },
  { cmd: '/model', desc: '查看/切换模型 profile' },
  { cmd: '/stats', desc: '会话统计' },
  { cmd: '/new', desc: '开启新会话（清空历史）' },
  { cmd: '/compact', desc: '压缩对话历史' },
  { cmd: '/retry', desc: '重发上一条输入' },
  { cmd: '/undo', desc: '撤销上一轮' },
  { cmd: '/think', desc: '思考强度 low|mid|high' },
  { cmd: '/clear', desc: '清除对话历史' },
  { cmd: '/help', desc: '显示帮助' },
  { cmd: '/exit', desc: '退出 Agent' },
];

/** readline Tab 补全：/ 开头时补全内置命令 + 已保存技能名 */
function slashCompleter(line: string): [string[], string] {
  if (!line.startsWith('/')) return [[], line];
  const names = [
    ...SLASH_COMMANDS.map((c) => c.cmd),
    ...listSkills().map((s) => '/' + s.name),
  ];
  const hits = names.filter((c) => c.startsWith(line));
  return [hits.length ? hits : names, line];
}

/** 输入单个 / 时弹出的命令菜单文本 */
function slashHint(): string {
  const lines = SLASH_COMMANDS.map((c) => `  ${chalk.cyan(c.cmd.padEnd(9))} ${chalk.dim(c.desc)}`);
  const skills = listSkills();
  if (skills.length) {
    lines.push(chalk.dim(`  — 技能（/<名>）：`) + skills.slice(0, 8).map((s) => '/' + s.name).join(' '));
  }
  return chalk.bold('可用命令（Tab 补全）：') + '\n' + lines.join('\n');
}


export async function startAgentRepl(config: SejuaniConfig, opts: ReplOptions = {}): Promise<void> {
  // 前置检查
  if (!aiConfigured()) {
    logger.error('尚未配置 AI apiKey。请先执行：sjn ai-config set-key <key>（或设置环境变量 OPENAI_API_KEY）。');
    return;
  }

  const brain = new AgentBrain(config, { model: opts.model, sessionId: opts.session, resume: !!opts.session });

  // 当前思考指示器（生成中）；工具日志/回复打印前会被停掉
  let activeSpinner: Spinner | null = null;

  // 注入三态确认（是/否/总是允许）与布尔确认回落
  brain.setConfirmEx(inquirerConfirmEx);
  brain.setConfirm(async (message) => (await inquirerConfirmEx(message)) !== 'no');

  // 注入输入回调（工作流 needsInput 补全）
  brain.setPromptInput(inquirerInput);

  // 注入输出（工具日志等）：打印前先停掉思考 spinner，避免单行冲突
  brain.setPrint((text) => {
    if (activeSpinner) { activeSpinner.stop(); activeSpinner = null; }
    console.log(text);
  });

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
    completer: slashCompleter,
  });

  // goal 模式运行中的 harness（SIGINT 中断链路用）
  let activeHarness: AgentHarness | null = null;
  // U1 交互命令状态：上一条用户输入（/retry）与思考强度（/think）
  let lastUserInput = '';
  let thinkLevel: '' | 'low' | 'mid' | 'high' = '';

  // 把整个 REPL 生命周期包为一个 Promise：直到 rl close 才 resolve。
  // 否则 startAgentRepl 一 return，index.ts 的 .then() 会立即 process.exit() 把 REPL 杀掉。
  let resolveRepl: () => void = () => {};
  const replDone = new Promise<void>((resolve) => {
    resolveRepl = resolve;
  });

  rl.prompt();

  // 实时过滤命令浮层（对齐 opencode：随输入收窄）。仅 TTY。
  // 关键：readline 每次刷新输入行会 self clearScreenDown（清除下方），所以我们只需
  // 在它刷新后于下方“追加”菜单，并用相对光标移动（滚动安全）把光标移回输入行；
  // 下一次按键 readline 自行清除旧菜单——顺应 readline，不再用不可靠的保存/恢复光标。
  const PROMPT_W = 5; // “sjn> ” 显示宽
  const dispWidth = (s: string): number => {
    let w = 0;
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6))) ? 2 : 1;
    }
    return w;
  };
  // 按显示宽度截断（含 CJK），防窄终端菜单行折行导致光标回位行数不足
  const clipW = (str: string, max: number): string => {
    let w = 0, out = '';
    for (const ch of str) {
      const cw = dispWidth(ch);
      if (w + cw > max) { out += '…'; break; }
      out += ch; w += cw;
    }
    return out;
  };
  let menuOpen = false;
  if (process.stdin.isTTY) {
    process.stdin.on('keypress', () => {
      setImmediate(() => {
        // 关键：readline 在“行尾追加字符”时只回显、**不** clearScreenDown，旧菜单不会被清。
        // 所以每次都主动先清除下方旧菜单（光标此刻在输入行光标位，其后无有效内容）。
        if (menuOpen) { process.stdout.write('\x1b[0J'); menuOpen = false; }
        const l = rl.line ?? '';
        const m = /^\/([a-zA-Z0-9._-]*)$/.exec(l); // 仅“斜杠+命令名”阶段（无空格/参数）才提示
        if (!m) return;
        const q = l.toLowerCase();
        const all = [
          ...SLASH_COMMANDS,
          ...listSkills().map((s) => ({ cmd: '/' + s.name, desc: s.description || '技能' })),
        ];
        const items = all.filter((it) => it.cmd.toLowerCase().startsWith(q)).slice(0, 8);
        if (items.length === 0) return;
        const maxW = Math.max(24, (process.stdout.columns || 80) - 2);
        const rows = items.map((it, idx) => {
          const desc = clipW(it.desc, Math.max(4, maxW - 14)); // 前缀（❯ + cmd(10) + 空格）约 14 列
          return (idx === 0 ? chalk.green('❯ ') : '  ') + chalk.cyan(it.cmd.padEnd(10)) + ' ' + chalk.dim(desc);
        });
        const col = PROMPT_W + dispWidth(l.slice(0, rl.cursor ?? l.length));
        let s = '';
        for (const r of rows) s += '\n\x1b[0K' + r;          // 下方逐行写菜单（每行先清行尾）
        s += `\x1b[${rows.length}A`;                       // 相对上移回输入行
        s += '\r' + (col > 0 ? `\x1b[${col}C` : '');       // 回到输入光标列
        process.stdout.write(s);
        menuOpen = true;
      });
    });
  }

  rl.on('line', async (line) => {
    // 提交时清除过滤浮层（回车后光标已移到输入行下方，清除光标至屏幕末的菜单残留）
    if (menuOpen) { process.stdout.write('\x1b[0J'); menuOpen = false; }
    let input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // 单个 / （回车）：弹出完整命令菜单（帮助）
    if (input === '/') {
      console.log(slashHint());
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
          else if (e.type === 'skill-suggest') console.log(chalk.dim(`\n💡 ${e.reason ?? ''}，可用 /skill save 固化为技能`));
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

    // U1 异步交互命令（需 await/重跑）
    const lower = input.toLowerCase();
    if (lower === '/new' || lower === '/reset') {
      brain.clearHistory();
      lastUserInput = '';
      console.log(chalk.dim('  已开启新会话（历史已清）。'));
      rl.prompt();
      return;
    }
    if (lower === '/compact') {
      const did = await brain.compactNow();
      console.log(chalk.dim(did ? '  已压缩对话历史。' : '  历史较短，无需压缩。'));
      rl.prompt();
      return;
    }
    if (lower === '/undo') {
      const ok = brain.undoLastTurn();
      console.log(chalk.dim(ok ? '  已撤销上一轮。' : '  无可撤销内容。'));
      rl.prompt();
      return;
    }
    if (lower === '/think' || lower.startsWith('/think ')) {
      const lv = input.trim().split(/\s+/)[1] as 'low' | 'mid' | 'high' | undefined;
      if (lv && ['low', 'mid', 'high'].includes(lv)) {
        thinkLevel = lv;
        console.log(chalk.dim(`  思考强度已设为 ${lv}。`));
      } else {
        console.log(chalk.dim(`  当前思考强度：${thinkLevel || '默认'}。用法：/think low|mid|high`));
      }
      rl.prompt();
      return;
    }
    if (lower === '/retry') {
      if (!lastUserInput) {
        console.log(chalk.dim('  无上一条输入可重发。'));
        rl.prompt();
        return;
      }
      // 重新走下方对话流程
      input = lastUserInput;
    }
    if (lower === '/profile') {
      try {
        console.log(chalk.dim('  正在从当前会话反思用户画像…'));
        const facts = await reflectUserProfile(brain.getConfig(), brain.getHistory());
        if (facts.length === 0) { console.log(chalk.dim('  无新增画像事实。')); rl.prompt(); return; }
        console.log(chalk.dim('  推断画像：\n' + facts.map((f) => '    · ' + f).join('\n')));
        const ok = await inquirerConfirm('写入这些画像到长期记忆？');
        if (ok) { const n = saveProfileFacts(brain.getConfig().activeDomain, facts); console.log(chalk.green(`  已写入 ${n} 条画像记忆`)); }
        else console.log(chalk.dim('  已取消。'));
      } catch (err) {
        console.log(chalk.red(`  反思失败：${(err as Error).message}`));
      }
      rl.prompt();
      return;
    }
    if (lower === '/skill' || lower.startsWith('/skill ')) {
      const parts = input.trim().split(/\s+/);
      const sub = (parts[1] ?? 'list').toLowerCase();
      if (sub === 'list') {
        const skills = listSkills();
        console.log(chalk.dim(skills.length ? skills.map((s) => `  ${s.name} (${s.kind}) ${s.description}`).join('\n') : '  （暂无技能）'));
      } else if (sub === 'save') {
        try {
          console.log(chalk.dim('  正在从当前会话提炼技能草案…'));
          const draft = await draftSkillFromHistory(brain.getConfig(), brain.getHistory(), { name: parts[2] });
          console.log(chalk.dim(`  草案：${draft.name} (${draft.kind}) - ${draft.description}`));
          const ok = await inquirerConfirm(`保存技能 ${draft.name}？`);
          if (ok) { saveSkill(draft); console.log(chalk.green(`  已保存技能 ${draft.name}`)); }
          else console.log(chalk.dim('  已取消。'));
        } catch (err) {
          console.log(chalk.red(`  提炼失败：${(err as Error).message}`));
        }
      } else {
        console.log(chalk.dim('  用法：/skill list | /skill save [名]'));
      }
      rl.prompt();
      return;
    }

    // per-skill slash 命令（对齐 Hermes：每个技能即一个 /<name> 命令）：/<skill> [任务]
    // 保留名短路：不得遮蔽内置命令（即使存在同名技能）
    const RESERVED_SLASH = new Set([
      'exit', 'quit', 'q', 'clear', 'tools', 'stats', 'memory', 'model', 'todos', 'help',
      'goal', 'new', 'reset', 'compact', 'undo', 'retry', 'think', 'skill', 'profile',
    ]);
    if (input.startsWith('/') && !input.startsWith('/ ')) {
      const m = /^\/([a-zA-Z0-9._-]+)(?:\s+([\s\S]*))?$/.exec(input.trim());
      if (m && !RESERVED_SLASH.has(m[1].toLowerCase())) {
        const sk = loadSkill(m[1]);
        if (sk) {
          const task = (m[2] ?? '').trim();
          if (sk.kind === 'workflow') {
            const r = await runSkill(brain.getConfig(), sk, { confirm: inquirerConfirm, promptInput: inquirerInput, params: task ? { task } : undefined });
            console.log(r.ok ? chalk.green(`  ${r.summary}`) : chalk.yellow(`  ${r.summary}`));
            rl.prompt();
            return;
          }
          // prompt 型：把技能指南作为上下文 + 用户任务，走正常对话流程
          input = `【技能：${sk.title || sk.name}】\n${sk.guide ?? ''}${task ? `\n\n任务：${task}` : ''}`;
          // 不 return，落到下方 brain.process
        }
      }
    }

    // 内置命令
    if (input.startsWith('/') && input === line.trim()) {
      const handled = handleCommand(input, brain);
      if (handled === 'exit') {
        rl.close();
        return;
      }
      rl.prompt();
      return;
    }

    // 调用 Agent Brain（收齐完整回复后渲染 Markdown；生成中显示思考 spinner）
    try {
      lastUserInput = input;
      const THINK: Record<string, string> = {
        low: '（简洁作答，少推理）',
        mid: '（适度思考后作答）',
        high: '（请先充分拆解与推理再作答）',
      };
      const sendInput = thinkLevel ? `${THINK[thinkLevel]} ${input}` : input;
      const before = brain.getStats();
      const startAt = Date.now();
      console.log('');
      activeSpinner = startSpinner('思考中');
      let response: string;
      try {
        response = await brain.process(sendInput);
      } finally {
        if (activeSpinner) { activeSpinner.stop(); activeSpinner = null; }
      }
      // 助手回复分隔标记 + 渲染 Markdown
      console.log(chalk.cyan('⏺ ') + chalk.bold('Sejuani'));
      console.log(renderMarkdown(response));
      // 每轮状态 footer（模型 · 本轮 token · 耗时）
      const after = brain.getStats();
      const dtok = (after.promptTokens + after.completionTokens) - (before.promptTokens + before.completionTokens);
      const dcalls = after.toolCalls - before.toolCalls;
      const secs = ((Date.now() - startAt) / 1000).toFixed(1);
      const model = getAiConfig().model || '';
      const parts = [model && `⚡ ${model}`, dtok > 0 && `+${dtok} tokens`, dcalls > 0 && `${dcalls} 工具`, `${secs}s`].filter(Boolean);
      console.log(chalk.dim('  ' + parts.join(' · ')));
      console.log('');
    } catch (err) {
      if (activeSpinner) { activeSpinner.stop(); activeSpinner = null; }
      console.log(chalk.red(`\n[错误] ${(err as Error).message}\n`));
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log(chalk.dim('\n再见！'));
    resolveRepl();
  });

  // Ctrl+C：执行中第一次提示、第二次中断；空闲时退出 REPL（当前行有内容则先清行）
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
    // 空闲态：当前行有未提交内容 → 清空输入；否则退出 REPL
    if (rl.line && rl.line.length > 0) {
      // @ts-ignore 清空当前输入行（readline 无公开 API，直接重置缓冲并重绘）
      (rl as any).line = '';
      // @ts-ignore
      (rl as any).cursor = 0;
      console.log('');
      rl.prompt();
      return;
    }
    rl.close(); // 触发 close 处理器（“再见！” + resolveRepl → 退出）
  });

  // 挂起直到 REPL 关闭，防止 index.ts 在 action 返回后立即 process.exit
  await replDone;
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
  /skill    技能：/skill list 列出 · /skill save [名] 固化当前会话
  /profile  从当前会话反思并更新用户画像（写入长期记忆）
  /<技能名> [任务]  直接调用一个已保存技能（workflow 型立即执行 / prompt 型载入指南）
  /new      开启新会话（清空历史，同 /clear）
  /compact  立即压缩对话历史
  /retry    重发上一条输入
  /undo     撤销上一轮对话
  /think    设思考强度：/think low|mid|high
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
      else if (e.type === 'skill-suggest') console.log(chalk.dim(`\n💡 ${e.reason ?? ''}`));
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
