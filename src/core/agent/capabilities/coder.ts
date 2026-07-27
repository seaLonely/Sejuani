import { Capability, AgentTool, ToolResult } from '../types';
import { getCoderConfig, listCoders, setActiveCoder, isCoderTool, CoderTool } from '../../state/coderConfig';
import { getCoderAdapter, buildFixPrompt } from '../../coder/registry';

/**
 * 编码辅助能力模块：调用本地 AI 编码工具（claude/kimi/opencode）执行编码任务。
 */

const coderFix: AgentTool = {
  name: 'coder_fix',
  description: '调用本地 AI 编码工具修复指定缺陷（在目标工程目录中执行）',
  parameters: {
    type: 'object',
    properties: {
      repoDir: { type: 'string', description: '目标工程目录的绝对路径' },
      identifier: { type: 'string', description: '工单编号（如 BENZ-5650）' },
      subject: { type: 'string', description: '缺陷标题' },
      description: { type: 'string', description: '缺陷描述' },
      files: { type: 'array', items: { type: 'string' }, description: '可选，建议重点关注的文件路径' },
    },
    required: ['repoDir', 'identifier', 'subject'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const cfg = getCoderConfig();
    const adapter = getCoderAdapter(cfg.activeTool);
    const prompt = buildFixPrompt({
      identifier: String(args.identifier),
      subject: String(args.subject),
      description: args.description ? String(args.description) : undefined,
      files: Array.isArray(args.files) ? args.files.map(String) : undefined,
    });
    const result = await adapter.run({ repoDir: String(args.repoDir), prompt });
    return result.ok
      ? { success: true, output: `编码工具 ${cfg.activeTool} 已完成修复。请检查工作区变更。` }
      : { success: false, output: `编码工具执行失败: ${result.reason ?? '未知原因'}` };
  },
};

const coderAsk: AgentTool = {
  name: 'coder_ask',
  description: '向本地 AI 编码工具发送任意编码任务提示词（如加单测、重构代码等）',
  parameters: {
    type: 'object',
    properties: {
      repoDir: { type: 'string', description: '工程目录的绝对路径' },
      prompt: { type: 'string', description: '编码任务提示词（自然语言描述要做什么）' },
    },
    required: ['repoDir', 'prompt'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const cfg = getCoderConfig();
    const adapter = getCoderAdapter(cfg.activeTool);
    const result = await adapter.run({ repoDir: String(args.repoDir), prompt: String(args.prompt) });
    return result.ok
      ? { success: true, output: `编码工具 ${cfg.activeTool} 已完成任务。请检查工作区变更。` }
      : { success: false, output: `编码工具执行失败: ${result.reason ?? '未知原因'}` };
  },
};

const coderSetTool: AgentTool = {
  name: 'coder_set_tool',
  description: '切换默认使用的本地 AI 编码工具',
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: ['claude', 'kimi', 'opencode'], description: '目标工具名' },
    },
    required: ['tool'],
  },
  async execute(args): Promise<ToolResult> {
    const tool = String(args.tool);
    if (!isCoderTool(tool)) {
      return { success: false, output: `不支持的工具: ${tool}。可选: claude / kimi / opencode` };
    }
    setActiveCoder(tool as CoderTool);
    return { success: true, output: `已切换默认编码工具为 ${tool}。` };
  },
};

const coderStatus: AgentTool = {
  name: 'coder_status',
  readOnly: true,
  description: '展示当前编码工具配置（活跃工具、命令模板等）',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    const coders = listCoders();
    const lines = coders.map((c) => `${c.active ? '→' : ' '} ${c.tool}: ${c.command}`);
    return { success: true, output: `编码工具配置：\n${lines.join('\n')}` };
  },
};

export const coderCapability: Capability = {
  name: 'coder',
  description: '编码辅助：调用本地 AI 编码工具（claude/kimi/opencode）执行修复、编码任务',
  tools: [coderFix, coderAsk, coderSetTool, coderStatus],
};
