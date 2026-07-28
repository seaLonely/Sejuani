import { Capability, AgentTool, ToolResult } from '../types';
import { withMcpSession } from '../../mcp/client';
import { getMcpServerSpec, getNotionConfig, notionConfigured } from '../../state/mcpConfig';

/**
 * Notion 团队库能力（U5/K3）：绑定用户配置的 Notion MCP 服务器 + 4 个 database id。
 * 不臆测 Notion MCP 的 schema——工具名与参数在运行时经 notion_status 发现后，由 notion_call 调用。
 * K3：把 skill/workflow/需求/执行记录镜像到 Notion，由 Agent 用发现的建页工具 + 对应 db id 完成。
 */

const notionStatus: AgentTool = {
  name: 'notion_status',
  readOnly: true,
  external: true,
  description:
    'Notion 团队库入口：查看已配置的 Notion MCP 服务器、4 个数据库 id，并列出该服务器运行时暴露的工具（供接下来 notion_call 使用）。处理需求前先用它查有无现成流程。',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    if (!notionConfigured()) {
      return { success: false, output: 'Notion 未配置。用 sjn mcp add <name> 配置 MCP 服务器，再 sjn notion set-server/set-db 绑定团队库。' };
    }
    const { server, db } = getNotionConfig();
    const spec = getMcpServerSpec(server!);
    if (!spec) return { success: false, output: `Notion 绑定的服务器 ${server} 无启动配置。` };
    const dbLines = [
      `  requirements: ${db?.requirements ?? '(未设)'}`,
      `  skills: ${db?.skills ?? '(未设)'}`,
      `  workflows: ${db?.workflows ?? '(未设)'}`,
      `  runs: ${db?.runs ?? '(未设)'}`,
    ].join('\n');
    try {
      const tools = await withMcpSession(spec, (s) => s.listTools());
      const toolLines = tools.map((t) => `  - ${t.name}: ${t.description ?? ''}`).join('\n');
      return {
        success: true,
        output: `Notion 服务器: ${server}\n数据库:\n${dbLines}\n可用工具（运行时发现）:\n${toolLines}`,
        data: { server, db, tools },
      };
    } catch (err) {
      return { success: false, output: `连接 Notion MCP 失败：${(err as Error).message}` };
    }
  },
};

const notionCall: AgentTool = {
  name: 'notion_call',
  needsConfirm: true,
  description:
    '调用已配置 Notion MCP 服务器的一个工具（工具名/参数以 notion_status 发现为准）。args 中可用占位符 {{requirementsDb}}/{{skillsDb}}/{{workflowsDb}}/{{runsDb}} 引用对应 database id。用于把需求/技能/工作流/执行记录写入或查询团队库。',
  parameters: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Notion MCP 工具名（来自 notion_status）' },
      args: { type: 'object', description: '工具参数；支持 {{xxxDb}} 占位符替换为配置的 database id' },
    },
    required: ['tool'],
  },
  async execute(args): Promise<ToolResult> {
    if (!notionConfigured()) return { success: false, output: 'Notion 未配置（见 notion_status）。' };
    const { server, db } = getNotionConfig();
    const spec = getMcpServerSpec(server!)!;
    // 占位符替换：把 args JSON 中的 {{xxxDb}} 替换为配置的 database id
    const map: Record<string, string> = {
      '{{requirementsDb}}': db?.requirements ?? '',
      '{{skillsDb}}': db?.skills ?? '',
      '{{workflowsDb}}': db?.workflows ?? '',
      '{{runsDb}}': db?.runs ?? '',
    };
    let raw = JSON.stringify(args.args && typeof args.args === 'object' ? args.args : {});
    for (const [k, v] of Object.entries(map)) raw = raw.split(k).join(v);
    let callArgs: Record<string, unknown> = {};
    try {
      callArgs = JSON.parse(raw);
    } catch {
      callArgs = {};
    }
    try {
      const r = await withMcpSession(spec, (s) => s.callTool(String(args.tool), callArgs));
      return { success: r.ok, output: r.text || (r.ok ? '（无输出）' : '调用返回错误') };
    } catch (err) {
      return { success: false, output: `Notion 调用失败：${(err as Error).message}` };
    }
  },
};

export const notionCapability: Capability = {
  name: 'notion',
  description: 'Notion 团队库：需求/技能/工作流/执行记录的查与写（经用户配置的 Notion MCP）',
  tools: [notionStatus, notionCall],
};
