import { Capability, AgentTool, ToolResult } from '../types';
import { withMcpSession } from '../../mcp/client';
import { getMcpConfig, getMcpServerSpec } from '../../state/mcpConfig';

/**
 * 通用 MCP 能力（U5）：让 Agent 连接用户配置的任意 MCP 服务器。
 * 工具在运行时经 tools/list 发现，参数按发现的 inputSchema 传入——不臆测任何服务器专属 schema。
 * 写类调用经 mcp_call，needsConfirm（可能修改外部系统）。
 */

const mcpListTools: AgentTool = {
  name: 'mcp_list_tools',
  readOnly: true,
  external: true,
  description: '列出某个已配置 MCP 服务器暴露的工具（运行时发现，含各工具的参数 schema）。先发现再调用。',
  parameters: {
    type: 'object',
    properties: { server: { type: 'string', description: 'MCP 服务器名（sjn mcp list 可查）' } },
    required: ['server'],
  },
  async execute(args): Promise<ToolResult> {
    const server = String(args.server);
    const spec = getMcpServerSpec(server);
    if (!spec) return { success: false, output: `未配置 MCP 服务器：${server}（用 sjn mcp add 配置）` };
    try {
      const tools = await withMcpSession(spec, (s) => s.listTools());
      if (tools.length === 0) return { success: true, output: `服务器 ${server} 未暴露工具。` };
      const lines = tools.map((t) => `- ${t.name}: ${t.description ?? ''}`);
      return { success: true, output: lines.join('\n'), data: tools };
    } catch (err) {
      return { success: false, output: `连接 MCP 失败：${(err as Error).message}` };
    }
  },
};

const mcpCall: AgentTool = {
  name: 'mcp_call',
  needsConfirm: true,
  description:
    '调用某个 MCP 服务器的一个工具。参数 args 按 mcp_list_tools 发现的该工具 inputSchema 传入。可用于读写 Notion 等外部系统。',
  parameters: {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP 服务器名' },
      tool: { type: 'string', description: '工具名（来自 mcp_list_tools）' },
      args: { type: 'object', description: '工具参数对象（按其 inputSchema）' },
    },
    required: ['server', 'tool'],
  },
  async execute(args): Promise<ToolResult> {
    const server = String(args.server);
    const spec = getMcpServerSpec(server);
    if (!spec) return { success: false, output: `未配置 MCP 服务器：${server}` };
    const toolName = String(args.tool);
    const callArgs = args.args && typeof args.args === 'object' ? (args.args as Record<string, unknown>) : {};
    try {
      const r = await withMcpSession(spec, (s) => s.callTool(toolName, callArgs));
      return { success: r.ok, output: r.text || (r.ok ? '（无输出）' : '调用返回错误') };
    } catch (err) {
      return { success: false, output: `MCP 调用失败：${(err as Error).message}` };
    }
  },
};

export const mcpCapability: Capability = {
  name: 'mcp',
  description: 'MCP 集成：连接用户配置的外部 MCP 服务器（运行时发现工具后调用）',
  tools: [mcpListTools, mcpCall],
};

/** 供 system prompt 提示可用 MCP 服务器名 */
export function configuredMcpServers(): string[] {
  return Object.keys(getMcpConfig().servers ?? {});
}
