import { ChatMessage, chatWithTools, chatWithToolsStream, chatJSON, ToolCall } from '../aiClient';
import { chalk, logger } from '../../utils/logger';
import { logEvent } from '../../utils/fileLogger';
import { AgentContext, ConfirmAnswer } from './types';
import { getAllTools, getToolByName, getToolFunctions, getSystemPromptContext } from './registry';
import { SejuaniConfig, DOMAINS } from '../config';
import { AgentStats, appendAudit, digestArgs, loadSession, saveSession } from './sessionStore';
import { renderMemory } from './memory';
import { listSkills } from '../skill/store';
import { renderProjectContext } from './projectContext';

/**
 * Agent Brain：管理对话上下文、组装 system prompt、调 LLM、解析 tool_calls、调度执行。
 *
 * 核心流程：
 * 用户输入 → 追加 history → chatWithTools(Stream) → 若 content: 返回文本 →
 * 若 toolCalls: 执行（连续只读工具并行）→ 结果追加 history → 再次调 LLM（循环直到返回 content）
 *
 * 能力：流式增量输出（onDelta）、会话持久化与历史压缩、会话级授权（always）、
 * 中断（abort）、token/轮次统计与工具调用审计。
 */

/** 单轮最大 tool_calls 循环次数（安全阈值） */
const MAX_TOOL_ROUNDS = 10;

/** 历史保留的最大消息数（超出时先尝试 LLM 摘要压缩，失败退回硬裁剪） */
const MAX_HISTORY_MESSAGES = 60;

export interface BrainOptions {
  model?: string;
  /** 持久化会话 id：提供时每轮保存到 ~/.sejuani/agent-sessions/ 并写工具审计 */
  sessionId?: string;
  /** 提供 sessionId 时是否从 sessionStore 恢复历史 */
  resume?: boolean;
  /** 工具白名单（W4 agent.task 受限视图）：提供时白名单外工具对 LLM 不可见 */
  allowTools?: string[];
  /** 预授权工具：初始化即加入 grantedTools，needsConfirm 工具免确认（agent.task 白名单即授权边界） */
  grantedTools?: string[];
  /** 单轮最大 tool_calls 循环次数（缺省 10；agent.task 置 6 控制无人值守成本） */
  maxRounds?: number;
  /** S1 模型角色（缺省 chat；agent.task 传 agentTask 以使用巡检专用模型） */
  aiRole?: 'chat' | 'agentTask';
  /** 子代理深度（主 Agent 缺省 0；子代理为父深度+1） */
  subagentDepth?: number;
}

export interface ProcessOptions {
  /** 流式增量回调：提供时走流式请求（上游不支持时自动回落非流式） */
  onDelta?: (text: string) => void;
  /** 不下发工具（Harness 收尾总结用）：强制纯文本单轮，不会触发 tool_calls */
  noTools?: boolean;
}

export class AgentBrain {
  private ctx: AgentContext;
  private opts: BrainOptions;
  private createdAt = new Date().toISOString();
  private stats: AgentStats = {
    rounds: 0,
    toolCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    startedAt: this.createdAt,
  };
  /** 当前轮的中止信号（abort() 触发） */
  private currentAbort: AbortController | null = null;
  private abortRequested = false;
  /** 是否正在处理一轮对话 */
  private processing = false;
  /** Harness 注入的防循环护卫（普通聊天模式为 null，零开销） */
  private loopGuard: { record(t: string, h: string): void; repeatedCall(): string | null } | null = null;
  /** 防循环警告暂存：待全部 tool 消息 push 后才能注入 system（保护 tool_calls 协议） */
  private pendingLoopWarns: string[] = [];

  constructor(config: SejuaniConfig, opts: BrainOptions = {}) {
    const domainCfg = DOMAINS[config.activeDomain as keyof typeof DOMAINS];
    this.opts = opts;
    this.ctx = {
      domain: config.activeDomain,
      domainLabel: domainCfg?.label ?? config.activeDomain,
      config,
      history: [{ role: 'system', content: this.buildSystemPrompt(config) }],
      confirm: async () => true, // REPL/serve 层会覆盖
      grantedTools: new Set<string>(opts.grantedTools ?? []),
      print: (text) => logger.info(text),
      todos: [],
      subagentDepth: opts.subagentDepth ?? 0,
    };
    // 从 sessionStore 恢复历史（system prompt 用最新配置重建，其余沿用）
    if (opts.sessionId && opts.resume) {
      const rec = loadSession(opts.sessionId);
      if (rec) {
        const rest = rec.history.filter((m, i) => !(i === 0 && m.role === 'system'));
        this.ctx.history = [this.ctx.history[0], ...rest];
        this.createdAt = rec.createdAt;
        if (rec.stats) this.stats = rec.stats;
        if (rec.todos) this.ctx.todos = rec.todos;
      }
    }
  }

  /** 设置确认回调（REPL/serve 层注入） */
  setConfirm(fn: (message: string) => Promise<boolean>): void {
    this.ctx.confirm = fn;
  }

  /** 设置三态确认回调（支持「总是允许」；未注入时回落 confirm） */
  setConfirmEx(fn: (message: string) => Promise<ConfirmAnswer>): void {
    this.ctx.confirmEx = fn;
  }

  /** 设置输入回调（工作流 needsInput 补全用；REPL 注 inquirerInput，serve 注 SSE 输入桥） */
  setPromptInput(fn: (message: string) => Promise<string>): void {
    this.ctx.promptInput = fn;
  }

  /** 设置输出回调 */
  setPrint(fn: (text: string) => void): void {
    this.ctx.print = fn;
  }

  /** 受限工具视图：allowTools 提供时仅暴露白名单内工具；子代理（depth≥1）剔除 agent_dispatch 防递归 */
  private tools(): ReturnType<typeof getAllTools> {
    const all = getAllTools();
    const depthOk = (name: string): boolean => this.ctx.subagentDepth < 1 || name !== 'agent_dispatch';
    if (!this.opts.allowTools) return all.filter((t) => depthOk(t.name));
    const allow = new Set(this.opts.allowTools);
    return all.filter((t) => allow.has(t.name) && depthOk(t.name));
  }

  /** 获取已注册工具数量 */
  getToolCount(): number {
    return this.tools().length;
  }

  /** 获取全部工具名列表（供 /tools 命令） */
  getToolNames(): string[] {
    return this.tools().map((t) => `${t.name}: ${t.description}`);
  }

  /** 会话累计统计（轮次/工具调用/token 用量） */
  getStats(): AgentStats {
    return { ...this.stats };
  }

  /** 当前域（供 REPL /memory 等命令定位记忆存储） */
  getDomain(): string {
    return this.ctx.domain;
  }

  /** 当前子代理深度（agent_dispatch 工具用于构造子代理 depth+1） */
  getSubagentDepth(): number {
    return this.ctx.subagentDepth;
  }

  /** 当前任务清单（Harness 读完成度） */
  getTodos(): import('./todo').TodoItem[] {
    return this.ctx.todos;
  }

  /** 当前对话历史（/skill save 提炼技能用） */
  getHistory(): ChatMessage[] {
    return this.ctx.history;
  }

  /** 当前配置 */
  getConfig(): SejuaniConfig {
    return this.ctx.config;
  }

  /** 注入防循环护卫（Harness 自主循环时启用；传 null 关闭） */
  setLoopGuard(guard: { record(t: string, h: string): void; repeatedCall(): string | null } | null): void {
    this.loopGuard = guard;
  }

  /** 是否正在处理一轮对话 */
  isProcessing(): boolean {
    return this.processing;
  }

  /** 中断当前轮：终止进行中的 LLM 请求，跳过剩余工具执行 */
  abort(): void {
    this.abortRequested = true;
    this.currentAbort?.abort();
    logEvent('warn', 'agent.abort', {});
  }

  /**
   * 处理一轮用户输入，返回 LLM 的最终文本回复。
   * 可能触发多次 tool_calls 循环；提供 onDelta 时流式输出。
   */
  async process(userInput: string, procOpts: ProcessOptions = {}): Promise<string> {
    this.abortRequested = false;
    this.processing = true;
    try {
      // 上一轮若把历史撑过阈值，先压缩（LLM 摘要，失败退回硬裁剪）
      await this.compressHistoryIfNeeded();

      this.ctx.history.push({ role: 'user', content: userInput });

      const allowSet = this.opts.allowTools ? new Set(this.opts.allowTools) : null;
      const depthOk = (name: string): boolean => this.ctx.subagentDepth < 1 || name !== 'agent_dispatch';
      const toolFunctions = procOpts.noTools
        ? []
        : (allowSet
            ? getToolFunctions().filter((f) => allowSet.has(f.name))
            : getToolFunctions()
          ).filter((f) => depthOk(f.name));
      const maxRounds = procOpts.noTools ? 1 : (this.opts.maxRounds ?? MAX_TOOL_ROUNDS);
      let rounds = 0;

      while (rounds < maxRounds) {
        rounds++;
        if (this.abortRequested) return this.finish('[已取消] 本轮请求已中断。');

        this.currentAbort = new AbortController();
        let result;
        try {
          const callOpts = {
            model: this.opts.model,
            tools: toolFunctions,
            timeoutMs: 120000,
            signal: this.currentAbort.signal,
            role: this.opts.aiRole ?? ('chat' as const),
          };
          result = procOpts.onDelta
            ? await chatWithToolsStream(this.ctx.history, callOpts, procOpts.onDelta)
            : await chatWithTools(this.ctx.history, callOpts);
        } catch (err) {
          const errMsg = (err as Error).message;
          logEvent('error', 'agent.brain.error', { round: rounds, error: errMsg });
          if (this.abortRequested) return this.finish('[已取消] 本轮请求已中断。');
          return this.finish(`[Agent 错误] ${errMsg}`, false);
        } finally {
          this.currentAbort = null;
        }

        this.stats.rounds++;
        if (result.usage) {
          this.stats.promptTokens += result.usage.promptTokens;
          this.stats.completionTokens += result.usage.completionTokens;
        }

        // LLM 直接回复文本
        if (result.content !== undefined && (!result.toolCalls || result.toolCalls.length === 0)) {
          return this.finish(result.content);
        }

        // LLM 请求调用工具
        if (result.toolCalls && result.toolCalls.length > 0) {
          this.ctx.history.push({ role: 'assistant', content: '', tool_calls: result.toolCalls });
          const outputs = await this.executeToolBatch(result.toolCalls);
          result.toolCalls.forEach((tc, i) => {
            this.ctx.history.push({ role: 'tool', content: outputs[i], tool_call_id: tc.id });
          });
          // 防循环警告统一在全部 tool 消息之后注入（不能插在 assistant.tool_calls 与 tool 之间，否则下一轮请求 400）
          if (this.pendingLoopWarns.length > 0) {
            for (const warn of this.pendingLoopWarns) {
              this.ctx.history.push({ role: 'system', content: warn });
            }
            this.pendingLoopWarns = [];
          }
          this.stats.toolCalls += result.toolCalls.length;
          if (this.abortRequested) return this.finish('[已取消] 已中断剩余执行。');
          continue;
        }

        // 兜底：既无 content 也无 toolCalls
        return this.finish('[Agent] 收到空响应，请重试。', false);
      }

      return this.finish('[Agent] 超过最大工具调用轮次限制，已停止。请简化您的请求或分步执行。', false);
    } finally {
      this.processing = false;
    }
  }

  /** 收尾：把最终回复写入 history（可选）、持久化会话，返回文本 */
  private finish(text: string, pushHistory = true): string {
    if (pushHistory) this.ctx.history.push({ role: 'assistant', content: text });
    this.persist();
    return text;
  }

  /**
   * 执行同批 tool_calls：连续只读工具用 Promise.all 并行，
   * 遇到写类工具则先冲刷并行组再串行执行；结果按原始顺序返回。
   */
  private async executeToolBatch(calls: ToolCall[]): Promise<string[]> {
    const outputs = new Array<string>(calls.length);
    let i = 0;
    while (i < calls.length) {
      if (this.abortRequested) break;
      const tool = getToolByName(calls[i].function.name);
      if (tool?.readOnly) {
        let j = i;
        while (j < calls.length && getToolByName(calls[j].function.name)?.readOnly) j++;
        const group = calls.slice(i, j);
        const results = await Promise.all(group.map((tc) => this.executeTool(tc)));
        results.forEach((r, k) => (outputs[i + k] = r));
        i = j;
      } else {
        outputs[i] = await this.executeTool(calls[i]);
        i++;
      }
    }
    for (let k = 0; k < calls.length; k++) {
      if (outputs[k] === undefined) {
        outputs[k] = JSON.stringify({ success: false, output: '用户已中断，未执行该工具。' });
      }
    }
    return outputs;
  }

  /** 执行单个工具调用，返回结果文本 */
  private async executeTool(tc: ToolCall): Promise<string> {
    const tool = getToolByName(tc.function.name);
    if (!tool || (this.opts.allowTools && !this.opts.allowTools.includes(tool.name))) {
      return JSON.stringify({ success: false, output: `未知或未授权工具: ${tc.function.name}` });
    }

    let args: Record<string, any> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return JSON.stringify({ success: false, output: `工具参数解析失败: ${tc.function.arguments}` });
    }

    // Harness 防循环埋点：记录调用签名（脉方 digestArgs 脱敏）；命中重复则暂存警告（不在此直接 push，避免破坏 tool_calls 协议）
    if (this.loopGuard) {
      this.loopGuard.record(tool.name, digestArgs(args));
      const warn = this.loopGuard.repeatedCall();
      if (warn) this.pendingLoopWarns.push(warn);
    }

    // 危险操作需确认（会话内已授权的工具跳过）
    let confirmedLabel = 'none';
    if (tool.needsConfirm) {
      if (this.ctx.grantedTools.has(tool.name)) {
        confirmedLabel = 'granted';
      } else {
        const message = `即将执行 ${chalk.yellow(tool.name)}：${tool.description}\n参数：${JSON.stringify(args, null, 2)}`;
        const answer: ConfirmAnswer = this.ctx.confirmEx
          ? await this.ctx.confirmEx(message)
          : (await this.ctx.confirm(message)) ? 'yes' : 'no';
        if (answer === 'no') {
          this.audit(tool.name, args, false, 0, 'no');
          return JSON.stringify({ success: false, output: '用户取消了操作。' });
        }
        if (answer === 'always') this.ctx.grantedTools.add(tool.name);
        confirmedLabel = answer;
      }
    }

    this.ctx.print(chalk.dim(`  ▸ ${tool.name}(${Object.keys(args).join(', ')}) ...`));
    logEvent('info', 'agent.tool.execute', { name: tc.function.name, args });

    const startedAt = Date.now();
    try {
      const result = await tool.execute(args, this.ctx);
      logEvent('info', 'agent.tool.result', { name: tc.function.name, success: result.success });
      this.audit(tool.name, args, result.success, Date.now() - startedAt, confirmedLabel);
      return JSON.stringify({ success: result.success, output: result.output });
    } catch (err) {
      const errMsg = (err as Error).message;
      logEvent('error', 'agent.tool.error', { name: tc.function.name, error: errMsg });
      this.audit(tool.name, args, false, Date.now() - startedAt, confirmedLabel);
      return JSON.stringify({ success: false, output: `工具执行异常: ${errMsg}` });
    }
  }

  /** 写工具调用审计（仅持久化会话；参数经脱敏摘要） */
  private audit(tool: string, args: Record<string, unknown>, success: boolean, durationMs: number, confirmed: string): void {
    if (!this.opts.sessionId) return;
    appendAudit(this.opts.sessionId, {
      ts: new Date().toISOString(),
      tool,
      argsDigest: digestArgs(args),
      success,
      durationMs,
      confirmed,
    });
  }

  /** 持久化会话（仅提供 sessionId 时） */
  private persist(): void {
    if (!this.opts.sessionId) return;
    try {
      saveSession({
        id: this.opts.sessionId,
        createdAt: this.createdAt,
        updatedAt: new Date().toISOString(),
        history: this.ctx.history,
        stats: this.stats,
        todos: this.ctx.todos.length > 0 ? this.ctx.todos : undefined,
      });
    } catch {
      /* 持久化失败不影响对话 */
    }
  }

  /** 找到安全裁剪点：不从 tool_calls 序列中间截断 */
  private findSafeCutIndex(): number {
    let cutIndex = this.ctx.history.length - (MAX_HISTORY_MESSAGES - 1);
    while (cutIndex < this.ctx.history.length && this.ctx.history[cutIndex].role === 'tool') {
      cutIndex++;
    }
    if (cutIndex < this.ctx.history.length) {
      const msg = this.ctx.history[cutIndex];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        cutIndex++;
        while (cutIndex < this.ctx.history.length && this.ctx.history[cutIndex].role === 'tool') {
          cutIndex++;
        }
      }
    }
    return cutIndex;
  }

  /**
   * 历史压缩：超过阈值时把待裁剪段交 LLM 摘要为一条 system 附注；
   * 摘要仅尝试 1 次，失败退回硬裁剪（trimHistory）。
   */
  private async compressHistoryIfNeeded(): Promise<void> {
    if (this.ctx.history.length <= MAX_HISTORY_MESSAGES) return;
    const system = this.ctx.history[0];
    const cutIndex = this.findSafeCutIndex();
    const removed = this.ctx.history.slice(1, cutIndex);
    if (removed.length === 0) return;
    try {
      const res = await chatJSON(
        [
          {
            role: 'system',
            content:
              '你是对话摘要助手。把给定的对话历史（JSON 数组）压缩为一段简明中文摘要，保留关键事实、用户决定与产物（如工作流 id、MR 链接、组件名）。只返回 JSON：{"summary": "..."}',
          },
          { role: 'user', content: JSON.stringify(removed).slice(0, 12000) },
        ],
        { timeoutMs: 30000, role: 'compress' }
      );
      const summary = typeof res?.summary === 'string' ? res.summary.trim() : '';
      if (summary) {
        this.ctx.history = [
          system,
          { role: 'system', content: `[此前对话摘要] ${summary}` },
          ...this.ctx.history.slice(cutIndex),
        ];
        logEvent('info', 'agent.history.compressed', { removed: removed.length, summaryChars: summary.length });
        return;
      }
    } catch (err) {
      logEvent('warn', 'agent.history.compressFailed', { error: (err as Error).message });
    }
    this.trimHistory();
  }

  /** 裁剪历史（压缩失败的兜底），保留 system 消息 + 最近 N 条 */
  private trimHistory(): void {
    if (this.ctx.history.length <= MAX_HISTORY_MESSAGES) return;
    const system = this.ctx.history[0];
    const cutIndex = this.findSafeCutIndex();
    this.ctx.history = [system, ...this.ctx.history.slice(cutIndex)];
  }

  /** 组装 system prompt */
  private buildSystemPrompt(config: SejuaniConfig): string {
    const domainCfg = DOMAINS[config.activeDomain as keyof typeof DOMAINS];
    const capabilities = getSystemPromptContext();
    const memorySection = renderMemory(config.activeDomain);
    const projectSection = renderProjectContext(process.cwd());
    // 可用技能清单（K1.5）：引导“先查 skill 再造”，预算 ≤1500 字符
    const skills = listSkills();
    let skillSection = '';
    if (skills.length > 0) {
      const lines = ['【可用技能】优先复用（用 skill_run 执行；无合适技能再自行处理）：'];
      let used = lines[0].length;
      for (const s of skills) {
        const line = `- ${s.name}(${s.kind}): ${s.description}`;
        if (used + line.length + 1 > 1500) break;
        lines.push(line);
        used += line.length + 1;
      }
      skillSection = lines.join('\n');
    }
    return [
      '你是 Sejuani Agent——一个面向前端工程的智能开发助手，运行在终端 CLI 中。',
      '你可以通过调用工具来管理组件/工程仓库、执行批量工作流、管理云效工单、自动化任务流程、检测开发环境、调用编码工具。',
      '',
      `当前域: ${config.activeDomain} (${domainCfg?.label ?? config.activeDomain})`,
      `组件库路径: ${config.roots.components.root}`,
      `工程库路径: ${config.roots.projects.root}`,
      '',
      '可用能力模块：',
      capabilities,
      '',
      '交互原则：',
      '1. 尽可能用一次工具调用完成用户请求，避免不必要的确认',
      '2. 对于不可逆操作（发布/push/流转状态），先向用户说明将要执行什么',
      '3. 查询类操作直接执行并汇总结果',
      '4. 若用户意图模糊，简明追问（不超过1个问题）',
      '5. 输出简洁有信息量，避免冗长',
      '6. 用中文回复',
      '7. 你可以在会话内直接规划并执行工作流（workflow_plan 规划并保存 → workflow_run 执行）；执行中的危险步骤会逐一征求用户确认，无需让用户去终端执行命令',
      '8. 你有长期记忆：当用户表达偏好、纠正你、约定命名/流程或确认重要项目事实时，用 memory_write 记住；记忆随下方【长期记忆】段注入',
      '9. 编码任务选择准则：中小改动（定位→精确编辑→验证）用内建 code_* 工具自主完成；预估改动超 5 个文件、需长时推理、或用户点名外部工具时，用 coder 工具委托 claude/codex',
      '10. 复杂任务可用 agent_dispatch 把独立子任务（如分别分析多个模块）拆给子 Agent 并行探索，子任务目标需自包含（子 Agent 看不到当前对话历史）',
      '11. 接到任务先用 skill_list 看有无可复用技能；完成可复用的多步流程后，可建议用 skill_save 固化',
      '12. 若已配置 Notion 团队库（notion_status 可查），处理需求单号前先查团队库有无现成流程；完成后可用 notion_call 把需求/技能/工作流/执行记录写回',
      skillSection ? '\n' + skillSection : '',
      projectSection ? '\n' + projectSection : '',
      memorySection ? '\n' + memorySection : '',
    ].join('\n');
  }

  /** 清除对话历史（保留 system） */
  clearHistory(): void {
    const system = this.ctx.history[0];
    this.ctx.history = [system];
  }

  /** 立即触发历史压缩（REPL /compact）；返回是否实际发生了压缩 */
  async compactNow(): Promise<boolean> {
    const before = this.ctx.history.length;
    await this.compressHistoryIfNeeded();
    return this.ctx.history.length < before;
  }

  /** 撤销上一轮（REPL /undo）：从尾部移除最近一组 assistant(+tool) 直到（含）上一条 user。
   * 保护 tool_calls 协议：整组移除，不留悬挂；且不动 system 消息（含压缩摘要）。返回是否有可撤销内容。 */
  undoLastTurn(): boolean {
    const h = this.ctx.history;
    let i = h.length - 1;
    let removed = false;
    while (i > 0) {
      const role = h[i].role;
      if (role === 'system') break; // 不弹 system（含压缩摘要）
      h.pop();
      removed = true;
      i--;
      if (role === 'user') break;
    }
    return removed;
  }
}
