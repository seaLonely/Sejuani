import { SejuaniConfig } from '../config';
import { AgentBrain, BrainOptions } from './brain';
import { AgentStats } from './sessionStore';
import { BudgetSpec, checkBudget } from './budget';
import { LoopGuard } from './loopGuard';
import { TodoItem, isAllDone, todoSummary, todosSignature } from './todo';
import { runCommand } from '../exec';
import { snapshotGit, changedSince, writeReport, GitSnapshot } from './report';
import { upsertMemory } from './memory';
import { SKILL_SUGGEST_THRESHOLD } from '../skill/creator';

/**
 * AgentHarness（H1）：包裹 AgentBrain 的外层自主执行壳。
 * runGoal(goal) = 注入目标指令 → 迭代（预算闸 → 熔断闸 → brain.process → 读 todo 完成度）
 * → 任何终局都产出 LLM 总结，绝不静默死循环。
 * 组合方式包裹，不入侵 brain 对话逻辑。
 */

export type HarnessOutcome = 'completed' | 'budget-exhausted' | 'stalled' | 'aborted' | 'max-iterations';

export interface HarnessEvent {
  type: 'iteration-start' | 'iteration-end' | 'todo-update' | 'budget-warn' | 'loop-warn' | 'verify' | 'skill-suggest' | 'finish';
  iteration?: number;
  todos?: TodoItem[];
  reason?: string;
}

/** H2 验证回路配置 */
export interface VerifySpec {
  /** 验证命令的工作目录 */
  workDir: string;
  /** 可执行程序（如 npm/yarn/node） */
  command: string;
  /** 参数数组（如 ['run','build']） */
  args?: string[];
  /** 失败最多回喂自修复次数，默认 2 */
  maxFixAttempts?: number;
}

export interface HarnessOptions {
  budget?: BudgetSpec;
  /** 外层自主迭代上限，默认 8 */
  maxIterations?: number;
  sessionId?: string;
  allowTools?: string[];
  grantedTools?: string[];
  aiRole?: 'chat' | 'agentTask';
  /** 迭代/todo/预算/熔断事件外发 */
  onProgress?: (e: HarnessEvent) => void;
  /** 逐字流式输出透传 */
  onDelta?: (text: string) => void;
  /** H2 验证回路：收尾前跑验证命令，失败回喂自修复重试 */
  verify?: VerifySpec;
  /** H3 快照/报告：执行前 git 快照、终局报告落盘的工作目录 */
  workDir?: string;
  /** H3 报告落盘使用的 id（缺省用 sessionId；都无则不落盘） */
  reportId?: string;
  /** H4 经验沉淀：将本次总结作为 lesson 写入长期记忆（需传 memoryDomain） */
  memoryDomain?: string;
  /** 子代理深度（agent_dispatch 构造子 harness 时传 父depth+1） */
  subagentDepth?: number;
}

export interface HarnessResult {
  outcome: HarnessOutcome;
  iterations: number;
  todos: TodoItem[];
  summary: string;
  usage: AgentStats;
  /** H3 报告落盘路径（若启用） */
  reportPath?: string;
  /** H3 本次改动文件（git 快照对比） */
  changed?: string[];
}

const GOAL_PROTOCOL = [
  '你现在进入自主执行模式，需要达成以下目标。请遵循协议：',
  '1. 首先用 todo_write 把目标拆解为可执行的任务清单；',
  '2. 每完成一项就用 todo_write 更新其 status（in-progress→done）；',
  '3. 目标全部达成后，把所有任务标记为 done，并明确说明「已完成」；',
  '4. 无法完成的任务标记为 cancelled 并说明原因。',
  '',
  '目标：',
].join('\n');

export class AgentHarness {
  private brain: AgentBrain;
  private guard = new LoopGuard();
  private opts: HarnessOptions;
  private aborted = false;

  constructor(config: SejuaniConfig, opts: HarnessOptions = {}) {
    this.opts = opts;
    const brainOpts: BrainOptions = {
      sessionId: opts.sessionId,
      resume: !!opts.sessionId,
      allowTools: opts.allowTools,
      grantedTools: opts.grantedTools,
      aiRole: opts.aiRole,
      subagentDepth: opts.subagentDepth,
    };
    this.brain = new AgentBrain(config, brainOpts);
    this.brain.setLoopGuard(this.guard);
  }

  /** 复用已有 brain（REPL /goal 场景，共享会话历史与授权） */
  static fromBrain(brain: AgentBrain, opts: HarnessOptions = {}): AgentHarness {
    const h = Object.create(AgentHarness.prototype) as AgentHarness;
    (h as any).brain = brain;
    (h as any).guard = new LoopGuard();
    (h as any).opts = opts;
    (h as any).aborted = false;
    brain.setLoopGuard((h as any).guard);
    return h;
  }

  /** 供 REPL 注入确认/输入/打印回调 */
  getBrain(): AgentBrain {
    return this.brain;
  }

  abort(): void {
    this.aborted = true;
    this.brain.abort();
  }

  private emit(e: HarnessEvent): void {
    try {
      this.opts.onProgress?.(e);
    } catch {
      /* 事件回调异常忽略 */
    }
  }

  async runGoal(goal: string): Promise<HarnessResult> {
    try {
      return await this.runGoalInner(goal);
    } finally {
      // Fix#4：goal 结束后摘除 loopGuard，避免污染后续普通对话（共享 brain 场景）
      this.brain.setLoopGuard(null);
    }
  }

  private async runGoalInner(goal: string): Promise<HarnessResult> {
    const startedAt = Date.now();
    const budget = this.opts.budget ?? {};
    const maxIterations = this.opts.maxIterations ?? 8;
    let outcome: HarnessOutcome = 'max-iterations';
    let iterations = 0;

    // Fix#5：预算按本次 runGoal 增量计量（共享 brain 时历史消耗不应计入）
    const base = this.brain.getStats();
    const delta = (): AgentStats => {
      const s = this.brain.getStats();
      return {
        rounds: s.rounds - base.rounds,
        toolCalls: s.toolCalls - base.toolCalls,
        promptTokens: s.promptTokens - base.promptTokens,
        completionTokens: s.completionTokens - base.completionTokens,
        startedAt: s.startedAt,
      };
    };

    // H3 执行前 git 快照
    const snap: GitSnapshot | undefined = this.opts.workDir ? snapshotGit(this.opts.workDir) : undefined;

    let input = `${GOAL_PROTOCOL}\n${goal}`;

    for (let i = 1; i <= maxIterations; i++) {
      iterations = i;
      if (this.aborted) {
        outcome = 'aborted';
        break;
      }
      // 预算闸（增量计量）
      const b = checkBudget(budget, delta(), startedAt);
      if (!b.ok) {
        this.emit({ type: 'budget-warn', iteration: i, reason: b.reason });
        outcome = 'budget-exhausted';
        break;
      }
      // 熔断闸
      if (this.guard.stalled()) {
        this.emit({ type: 'loop-warn', iteration: i, reason: '连续无进展' });
        outcome = 'stalled';
        break;
      }

      this.emit({ type: 'iteration-start', iteration: i });
      await this.brain.process(input, { onDelta: this.opts.onDelta });
      const todos = this.brain.getTodos();
      this.emit({ type: 'todo-update', iteration: i, todos });
      this.guard.snapshotIteration(todosSignature(todos));
      this.emit({ type: 'iteration-end', iteration: i, todos });

      // 完成判定：todo 全 done/cancelled → completed；无 todo 时软判定（本轮无续跑动作即视为答复完成）
      if (isAllDone(todos)) {
        outcome = 'completed';
        break;
      }
      if (todos.length === 0) {
        // LLM 未使用 todo：视为一次性问答，已完成
        outcome = 'completed';
        break;
      }
      input = `继续执行未完成的任务（todo_read 可查看当前清单）。全部完成后请标记 done 并说明「已完成」。`;
    }

    // H2 验证回路：完成后跑验证命令，失败回喂 LLM 自修复重试
    if (outcome === 'completed' && this.opts.verify) {
      outcome = await this.runVerifyLoop(this.opts.verify, startedAt, budget, base);
    }

    const summary = await this.summarize(outcome);
    // H3 改动文件与报告落盘
    const changed = snap && this.opts.workDir ? changedSince(this.opts.workDir, snap) : [];
    const result: HarnessResult = {
      outcome,
      iterations,
      todos: this.brain.getTodos(),
      summary,
      usage: this.brain.getStats(),
      changed: changed.length > 0 ? changed : undefined,
    };
    const reportId = this.opts.reportId ?? this.opts.sessionId;
    if (reportId) {
      try {
        result.reportPath = writeReport(reportId, {
          goal,
          outcome,
          iterations,
          todos: result.todos,
          summary,
          usage: result.usage,
          workDir: this.opts.workDir,
          snapshot: snap,
          changed,
        });
      } catch {
        /* 报告落盘失败不影响结果 */
      }
    }
    // H4 经验沉淀：把本次总结写入 lesson 长期记忆
    if (this.opts.memoryDomain && summary && outcome !== 'aborted') {
      try {
        upsertMemory(this.opts.memoryDomain, {
          category: 'lesson',
          content: `目标「${goal.slice(0, 40)}」(${outcome}): ${summary.slice(0, 150)}`,
        });
      } catch {
        /* 记忆写入失败不影响结果 */
      }
    }
    // U3 技能自创建建议：完成且工具调用达阈值时 emit（交互模式提示固化，无人值守仅记录）
    if (outcome === 'completed' && result.usage.toolCalls >= SKILL_SUGGEST_THRESHOLD) {
      this.emit({ type: 'skill-suggest', reason: `本次流程（${result.usage.toolCalls} 次工具调用）可固化为技能` });
    }
    this.emit({ type: 'finish', reason: outcome, todos: result.todos });
    return result;
  }

  /** 收尾总结：abort 用本地拼装，其它让 LLM 产出「进度+未完成项」 */
  private async summarize(outcome: HarnessOutcome): Promise<string> {
    const todos = this.brain.getTodos();
    if (outcome === 'aborted') {
      return `[已中断] 完成度 ${todoSummary(todos)}。`;
    }
    const prompt =
      outcome === 'completed'
        ? '请用一段话总结你完成了什么、产生了哪些产物（如工作流 id/MR/改动文件）。'
        : `本轮自主执行因「${outcome}」结束。请总结：已完成什么、还有哪些未完成项、建议的下一步。`;
    try {
      // Fix#6：总结轮禁用工具（纯文本单轮），避免预算耗尽/熔断后继续消耗工具调用与重复
      return await this.brain.process(prompt, { onDelta: this.opts.onDelta, noTools: true });
    } catch {
      return `执行结束（${outcome}）。任务完成度 ${todoSummary(todos)}。`;
    }
  }

  /**
   * H2 验证回路：执行 verify 命令；失败则把输出回喂 LLM 自修复并重跑，
   * 最多 maxFixAttempts 次。全绿返回 completed；仍失败返回 stalled（如实报告未通过）。
   */
  private async runVerifyLoop(
    verify: VerifySpec,
    startedAt: number,
    budget: BudgetSpec,
    base: AgentStats
  ): Promise<HarnessOutcome> {
    const deltaStats = (): AgentStats => {
      const s = this.brain.getStats();
      return {
        rounds: s.rounds - base.rounds,
        toolCalls: s.toolCalls - base.toolCalls,
        promptTokens: s.promptTokens - base.promptTokens,
        completionTokens: s.completionTokens - base.completionTokens,
        startedAt: s.startedAt,
      };
    };
    const maxFix = verify.maxFixAttempts ?? 2;
    for (let attempt = 0; attempt <= maxFix; attempt++) {
      const r = runCommand(verify.command, verify.args ?? [], { cwd: verify.workDir });
      const out = `${r.stdout}\n${r.stderr}`.trim();
      this.emit({ type: 'verify', reason: `[exit ${r.code}] attempt ${attempt}` });
      if (r.ok) return 'completed';
      if (attempt >= maxFix) {
        this.emit({ type: 'verify', reason: `验证仍失败，已达最大自修复次数 ${maxFix}` });
        return 'stalled';
      }
      // 预算保护（增量计量）：修复前再查一次预算
      if (!checkBudget(budget, deltaStats(), startedAt).ok) return 'budget-exhausted';
      // 回喂失败输出，要求修复
      const fixPrompt = [
        `验证命令 \`${verify.command} ${(verify.args ?? []).join(' ')}\` 失败（退出码 ${r.code}）。输出：`,
        '```',
        out.slice(-3000),
        '```',
        '请用 code_* 工具定位并修复问题，然后我会重新运行验证。',
      ].join('\n');
      await this.brain.process(fixPrompt, { onDelta: this.opts.onDelta });
    }
    return 'stalled';
  }
}
