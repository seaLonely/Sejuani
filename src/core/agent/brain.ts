import { ChatMessage, chatWithTools, ToolCall } from '../aiClient';
import { chalk, logger } from '../../utils/logger';
import { logEvent } from '../../utils/fileLogger';
import { AgentContext } from './types';
import { getAllTools, getToolByName, getToolFunctions, getSystemPromptContext } from './registry';
import { SejuaniConfig, DOMAINS } from '../../config';

/**
 * Agent Brain：管理对话上下文、组装 system prompt、调 LLM、解析 tool_calls、调度执行。
 *
 * 核心流程：
 * 用户输入 → 追加 history → chatWithTools → 若 content: 返回文本 →
 * 若 toolCalls: 逐个执行 → 结果追加 history → 再次调 LLM（循环直到返回 content）
 */

/** 单轮最大 tool_calls 循环次数（安全阈值） */
const MAX_TOOL_ROUNDS = 10;

/** 历史保留的最大消息数（超出时裁剪前面的轮次，保留 system） */
const MAX_HISTORY_MESSAGES = 60;

export interface BrainOptions {
  model?: string;
}

export class AgentBrain {
  private ctx: AgentContext;
  private opts: BrainOptions;

  constructor(config: SejuaniConfig, opts: BrainOptions = {}) {
    const domainCfg = DOMAINS[config.activeDomain as keyof typeof DOMAINS];
    this.opts = opts;
    this.ctx = {
      domain: config.activeDomain,
      domainLabel: domainCfg?.label ?? config.activeDomain,
      config,
      history: [{ role: 'system', content: this.buildSystemPrompt(config) }],
      confirm: async () => true, // REPL 层会覆盖
      print: (text) => logger.info(text),
    };
  }

  /** 设置确认回调（REPL 层注入） */
  setConfirm(fn: (message: string) => Promise<boolean>): void {
    this.ctx.confirm = fn;
  }

  /** 设置输出回调 */
  setPrint(fn: (text: string) => void): void {
    this.ctx.print = fn;
  }

  /** 获取已注册工具数量 */
  getToolCount(): number {
    return getAllTools().length;
  }

  /** 获取全部工具名列表（供 /tools 命令） */
  getToolNames(): string[] {
    return getAllTools().map((t) => `${t.name}: ${t.description}`);
  }

  /**
   * 处理一轮用户输入，返回 LLM 的最终文本回复。
   * 可能触发多次 tool_calls 循环。
   */
  async process(userInput: string): Promise<string> {
    // 追加用户消息
    this.ctx.history.push({ role: 'user', content: userInput });
    this.trimHistory();

    const toolFunctions = getToolFunctions();
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      let result;
      try {
        result = await chatWithTools(this.ctx.history, {
          model: this.opts.model,
          tools: toolFunctions,
          timeoutMs: 120000,
        });
      } catch (err) {
        const errMsg = (err as Error).message;
        logEvent('error', 'agent.brain.error', { round: rounds, error: errMsg });
        return `[Agent 错误] ${errMsg}`;
      }

      // LLM 直接回复文本
      if (result.content !== undefined && (!result.toolCalls || result.toolCalls.length === 0)) {
        this.ctx.history.push({ role: 'assistant', content: result.content });
        return result.content;
      }

      // LLM 请求调用工具
      if (result.toolCalls && result.toolCalls.length > 0) {
        // 记录 assistant 的 tool_calls 消息
        this.ctx.history.push({
          role: 'assistant',
          content: '',
          tool_calls: result.toolCalls,
        });

        // 逐个执行工具
        for (const tc of result.toolCalls) {
          const toolResult = await this.executeTool(tc);
          // 追加 tool 结果到 history
          this.ctx.history.push({
            role: 'tool',
            content: toolResult,
            tool_call_id: tc.id,
          });
        }
        // 继续循环让 LLM 根据工具结果决定下一步
        continue;
      }

      // 兜底：既无 content 也无 toolCalls
      return '[Agent] 收到空响应，请重试。';
    }

    return '[Agent] 超过最大工具调用轮次限制，已停止。请简化您的请求或分步执行。';
  }

  /** 执行单个工具调用，返回结果文本 */
  private async executeTool(tc: ToolCall): Promise<string> {
    const tool = getToolByName(tc.function.name);
    if (!tool) {
      return JSON.stringify({ success: false, output: `未知工具: ${tc.function.name}` });
    }

    let args: Record<string, any> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return JSON.stringify({ success: false, output: `工具参数解析失败: ${tc.function.arguments}` });
    }

    // 危险操作需确认
    if (tool.needsConfirm) {
      const ok = await this.ctx.confirm(
        `即将执行 ${chalk.yellow(tool.name)}：${tool.description}\n参数：${JSON.stringify(args, null, 2)}`
      );
      if (!ok) {
        return JSON.stringify({ success: false, output: '用户取消了操作。' });
      }
    }

    this.ctx.print(chalk.dim(`  ▸ ${tool.name}(${Object.keys(args).join(', ')}) ...`));
    logEvent('info', 'agent.tool.execute', { name: tc.function.name, args });

    try {
      const result = await tool.execute(args, this.ctx);
      logEvent('info', 'agent.tool.result', { name: tc.function.name, success: result.success });
      return JSON.stringify({ success: result.success, output: result.output });
    } catch (err) {
      const errMsg = (err as Error).message;
      logEvent('error', 'agent.tool.error', { name: tc.function.name, error: errMsg });
      return JSON.stringify({ success: false, output: `工具执行异常: ${errMsg}` });
    }
  }

  /** 裁剪历史，保留 system 消息 + 最近 N 条，确保不从 tool_call 序列中间截断 */
  private trimHistory(): void {
    if (this.ctx.history.length <= MAX_HISTORY_MESSAGES) return;
    const system = this.ctx.history[0]; // 保留 system prompt
    // 从目标裁剪点向后扫描，找到安全边界（非 tool 角色的消息）
    let cutIndex = this.ctx.history.length - (MAX_HISTORY_MESSAGES - 1);
    while (cutIndex < this.ctx.history.length && this.ctx.history[cutIndex].role === 'tool') {
      cutIndex++;
    }
    // 如果 cutIndex 指向的是 assistant 且有 tool_calls，也跳过它（保证 tool_calls+tool 序列完整）
    if (cutIndex < this.ctx.history.length) {
      const msg = this.ctx.history[cutIndex];
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        // 跳过这个 assistant + 它后面所有的 tool 消息
        cutIndex++;
        while (cutIndex < this.ctx.history.length && this.ctx.history[cutIndex].role === 'tool') {
          cutIndex++;
        }
      }
    }
    this.ctx.history = [system, ...this.ctx.history.slice(cutIndex)];
  }

  /** 组装 system prompt */
  private buildSystemPrompt(config: SejuaniConfig): string {
    const domainCfg = DOMAINS[config.activeDomain as keyof typeof DOMAINS];
    const capabilities = getSystemPromptContext();
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
    ].join('\n');
  }

  /** 清除对话历史（保留 system） */
  clearHistory(): void {
    const system = this.ctx.history[0];
    this.ctx.history = [system];
  }
}
