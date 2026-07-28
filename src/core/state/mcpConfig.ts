import { readState, writeState, stateFilePath } from './stateFile';
import { McpServerSpec } from '../mcp/client';

/**
 * MCP 服务器配置（U5）：读-合并-写回 ~/.sejuani/state.json 的 `mcp` 键。
 * 用户配置自己的 MCP 服务器（如 Notion MCP）：命令 + 参数 + 环境变量。
 * notion 键额外记录团队库的 4 个 database id（供 K3 镜像用）。
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface NotionDbConfig {
  requirements?: string;
  skills?: string;
  workflows?: string;
  runs?: string;
}

export interface McpConfig {
  /** 命名 MCP 服务器：name → 启动配置 */
  servers?: Record<string, McpServerConfig>;
  /** Notion 团队库：指向某个 server 名 + 4 个数据库 id */
  notion?: { server?: string; db?: NotionDbConfig };
}

export function getMcpConfig(): McpConfig {
  const raw = readState().mcp;
  return raw && typeof raw === 'object' ? raw : {};
}

/** 取某个 server 的启动 spec；不存在返回 null */
export function getMcpServerSpec(name: string): McpServerSpec | null {
  const s = getMcpConfig().servers?.[name];
  if (!s || !s.command) return null;
  return { command: s.command, args: s.args, env: s.env };
}

/** 新增/更新一个 MCP 服务器配置 */
export function setMcpServer(name: string, cfg: McpServerConfig): void {
  const state = readState();
  const mcp: McpConfig = state.mcp && typeof state.mcp === 'object' ? state.mcp : {};
  mcp.servers = { ...mcp.servers, [name]: cfg };
  state.mcp = mcp;
  writeState(state);
}

/** 删除一个 MCP 服务器配置 */
export function removeMcpServer(name: string): boolean {
  const state = readState();
  const mcp: McpConfig = state.mcp && typeof state.mcp === 'object' ? state.mcp : {};
  if (!mcp.servers || !mcp.servers[name]) return false;
  delete mcp.servers[name];
  state.mcp = mcp;
  writeState(state);
  return true;
}

/** 配置 Notion 团队库（server 名 + database id） */
export function setNotionConfig(patch: { server?: string; db?: Partial<NotionDbConfig> }): void {
  const state = readState();
  const mcp: McpConfig = state.mcp && typeof state.mcp === 'object' ? state.mcp : {};
  const prev = mcp.notion ?? {};
  mcp.notion = {
    server: patch.server ?? prev.server,
    db: { ...prev.db, ...patch.db },
  };
  state.mcp = mcp;
  writeState(state);
}

export function getNotionConfig(): { server?: string; db?: NotionDbConfig } {
  return getMcpConfig().notion ?? {};
}

/** Notion 是否已配置可用（有 server 且该 server 存在启动配置） */
export function notionConfigured(): boolean {
  const n = getNotionConfig();
  return !!(n.server && getMcpServerSpec(n.server));
}

export function mcpStateFilePath(): string {
  return stateFilePath();
}
