import { SejuaniConfig } from '../config';
import { PromptInputFn } from '../types';
import { ChatMessage } from '../aiClient';
import { TodoItem } from './todo';

/**
 * Agent 系统核心类型定义。
 * Agent 通过 Function Calling 协议与 LLM 交互，LLM 从注册的工具中选择调用。
 */

/** Agent 工具定义（注册到 brain 的能力单元） */
export interface AgentTool {
  /** 工具名称（全局唯一，蛇形命名如 repos_catalog） */
  name: string;
  /** 给 LLM 看的中文描述 */
  description: string;
  /** JSON Schema 格式的参数定义 */
  parameters: Record<string, any>;
  /** 是否需要用户确认后才执行（危险/不可逆操作） */
  needsConfirm?: boolean;
  /** 只读工具（查询类）：同批 tool_calls 中可并行执行 */
  readOnly?: boolean;
  /** 执行工具 */
  execute(args: Record<string, any>, ctx: AgentContext): Promise<ToolResult>;
}

/** 工具执行结果 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 返回给 LLM 的文本摘要（LLM 用此决定下一步或向用户汇报） */
  output: string;
  /** 结构化数据（可选，用于内部传递） */
  data?: any;
}

/** 三态确认应答：always = 本会话内后续同名工具不再询问 */
export type ConfirmAnswer = 'yes' | 'no' | 'always';

/** Agent 运行上下文（跨轮次共享） */
export interface AgentContext {
  /** 当前域标识 */
  domain: string;
  /** 域显示名 */
  domainLabel: string;
  /** 已加载的配置 */
  config: SejuaniConfig;
  /** 会话历史（自动裁剪/压缩） */
  history: ChatMessage[];
  /** 确认回调（危险操作前调用） */
  confirm(message: string): Promise<boolean>;
  /** 三态确认回调（支持「总是允许」）；未注入时回落 confirm */
  confirmEx?: (message: string) => Promise<ConfirmAnswer>;
  /** 会话内已授权免确认的工具名集合（仅内存，不持久化） */
  grantedTools: Set<string>;
  /** 输入回调：工作流 needsInput 补全用；REPL 注 inquirerInput，serve 注 SSE 输入桥 */
  promptInput?: PromptInputFn;
  /** 输出到终端（非 LLM 的直接输出） */
  print(text: string): void;
  /** Harness 任务清单（H1）：todo_write/read 工具读写，harness 读完成度 */
  todos: TodoItem[];
}

/** 能力模块（一组相关工具的集合） */
export interface Capability {
  /** 模块标识，如 'repos', 'workflow', 'yunxiao' */
  name: string;
  /** 给 system prompt 的模块一句话说明 */
  description: string;
  /** 该模块注册的全部工具 */
  tools: AgentTool[];
}
