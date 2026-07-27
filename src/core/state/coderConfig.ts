import { readState, writeState, stateFilePath } from './stateFile';

/**
 * 本地 AI 编码工具配置的持久化：读-合并-写回 ~/.sejuani/state.json 的 `coder` 键。
 *
 * 功能2「AI 辅助修复」以子进程方式调用本地编码 CLI（claude / kimi / opencode）。
 * 每个工具可覆盖可执行命令名与参数模板；参数模板里的 {prompt} 占位符会被替换为
 * 拼装好的修复提示词（见 core/coder/registry.ts）。
 */

/** 已内置支持的编码工具名 */
export type CoderTool = 'claude' | 'kimi' | 'opencode';

export interface CoderToolSpec {
  /** 可执行命令名或绝对路径 */
  command: string;
  /**
   * 参数模板：其中的 '{prompt}' 会被整体替换为修复提示词。
   * 缺省见 DEFAULT_TOOLS（各工具的非交互一次性执行方式）。
   */
  args: string[];
}

export interface CoderConfig {
  /** 当前默认使用的工具 */
  activeTool: CoderTool;
  /** 各工具的命令与参数模板 */
  tools: Record<CoderTool, CoderToolSpec>;
}

export interface CoderConfigPatch {
  activeTool?: CoderTool;
  tools?: Partial<Record<CoderTool, Partial<CoderToolSpec>>>;
}

/** 各工具默认命令与非交互参数模板（'{prompt}' 为提示词占位符）。 */
const DEFAULT_TOOLS: Record<CoderTool, CoderToolSpec> = {
  claude: { command: 'claude', args: ['-p', '{prompt}'] },
  kimi: { command: 'kimi', args: ['-p', '{prompt}'] },
  opencode: { command: 'opencode', args: ['run', '{prompt}'] },
};

const DEFAULT_ACTIVE: CoderTool = 'claude';

/** 全部内置工具名。 */
export const CODER_TOOLS: CoderTool[] = ['claude', 'kimi', 'opencode'];

/** 判断字符串是否为已知工具名。 */
export function isCoderTool(name: string): name is CoderTool {
  return (CODER_TOOLS as string[]).includes(name);
}

/** 读取生效的编码工具配置（补齐默认值，用户覆盖优先）。 */
export function getCoderConfig(): CoderConfig {
  const raw = readState().coder;
  const c: CoderConfigPatch = raw && typeof raw === 'object' ? raw : {};
  const active = typeof c.activeTool === 'string' && isCoderTool(c.activeTool) ? c.activeTool : DEFAULT_ACTIVE;
  const tools = {} as Record<CoderTool, CoderToolSpec>;
  for (const t of CODER_TOOLS) {
    const override = c.tools && typeof c.tools === 'object' ? c.tools[t] : undefined;
    tools[t] = {
      command:
        override && typeof override.command === 'string' && override.command.trim()
          ? override.command.trim()
          : DEFAULT_TOOLS[t].command,
      args: override && Array.isArray(override.args) ? override.args.map(String) : DEFAULT_TOOLS[t].args.slice(),
    };
  }
  return { activeTool: active, tools };
}

/** 取某个工具的生效命令与参数模板。 */
export function getCoderToolSpec(tool: CoderTool): CoderToolSpec {
  return getCoderConfig().tools[tool];
}

/** 合并写回编码工具配置（保留其它字段），返回写回后的生效配置。 */
export function setCoderConfig(patch: CoderConfigPatch): CoderConfig {
  const state = readState();
  const prev: CoderConfigPatch = state.coder && typeof state.coder === 'object' ? state.coder : {};
  const next: CoderConfigPatch = { ...prev };
  if (patch.activeTool !== undefined) next.activeTool = patch.activeTool;
  if (patch.tools) {
    next.tools = { ...(prev.tools ?? {}) };
    for (const t of Object.keys(patch.tools) as CoderTool[]) {
      next.tools[t] = { ...(prev.tools?.[t] ?? {}), ...(patch.tools[t] ?? {}) };
    }
  }
  state.coder = next;
  writeState(state);
  return getCoderConfig();
}

/** 设置默认工具（校验合法性）。 */
export function setActiveCoder(tool: CoderTool): CoderConfig {
  return setCoderConfig({ activeTool: tool });
}

/** 列出全部工具及其命令（用于 show）。 */
export function listCoders(): { tool: CoderTool; command: string; active: boolean }[] {
  const cfg = getCoderConfig();
  return CODER_TOOLS.map((t) => ({ tool: t, command: cfg.tools[t].command, active: t === cfg.activeTool }));
}
