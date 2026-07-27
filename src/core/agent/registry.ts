import { AgentTool, Capability } from './types';
import { ToolFunction } from '../aiClient';

// 导入所有能力模块
import { reposCapability } from './capabilities/repos';
import { yunxiaoCapability } from './capabilities/yunxiao';
import { workflowCapability } from './capabilities/workflow';
import { taskFlowCapability } from './capabilities/taskFlow';
import { envCapability } from './capabilities/env';
import { coderCapability } from './capabilities/coder';
import { memoryCapability } from './capabilities/memory';
import { todoCapability } from './capabilities/todo';
import { codeCapability } from './capabilities/code';

/**
 * 工具注册表：收集全部 Capability 模块，展平成 tools 数组供 brain 使用。
 */

const ALL_CAPABILITIES: Capability[] = [
  reposCapability,
  yunxiaoCapability,
  workflowCapability,
  taskFlowCapability,
  envCapability,
  coderCapability,
  memoryCapability,
  todoCapability,
  codeCapability,
];

/** 展平后的全部工具 */
let _allTools: AgentTool[] | null = null;

function ensureTools(): AgentTool[] {
  if (!_allTools) {
    _allTools = ALL_CAPABILITIES.flatMap((c) => c.tools);
  }
  return _allTools;
}

/** 获取全部已注册工具 */
export function getAllTools(): AgentTool[] {
  return ensureTools();
}

/** 按名称查找工具 */
export function getToolByName(name: string): AgentTool | undefined {
  return ensureTools().find((t) => t.name === name);
}

/** 转换为 OpenAI ToolFunction 格式（供 chatWithTools 使用） */
export function getToolFunctions(): ToolFunction[] {
  return ensureTools().map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/** 获取所有能力模块 */
export function getAllCapabilities(): Capability[] {
  return ALL_CAPABILITIES;
}

/** 生成 system prompt 中的能力模块概述 */
export function getSystemPromptContext(): string {
  return ALL_CAPABILITIES.map(
    (c) => `- ${c.name}: ${c.description}（${c.tools.length} 个工具）`
  ).join('\n');
}
