import { chalk, logger } from '../../utils/logger';
import { formatCommand, runCommandStream } from '../exec';
import { logEvent } from '../../utils/fileLogger';
import { CoderTool, CODER_TOOLS, getCoderToolSpec } from '../state/coderConfig';
import { CoderAdapter, CoderContext, CoderResult } from './adapter';

/**
 * 编码工具注册表：为每个内置工具生成一个通用适配器。
 *
 * 命令与参数模板来自 coderConfig（用户可覆盖）。参数模板里的 '{prompt}' 占位符
 * 会被整体替换为拼装好的修复提示词；其余参数原样传递。全部通过 runCommandStream
 * 在 repoDir 下执行并实时透传输出。
 */

/** 把参数模板中的 '{prompt}' 占位符替换为实际提示词。 */
function materializeArgs(argsTemplate: string[], prompt: string): string[] {
  return argsTemplate.map((a) => (a === '{prompt}' ? prompt : a.replace('{prompt}', prompt)));
}

/** 依据 coderConfig 为某工具构造通用适配器。 */
function makeAdapter(tool: CoderTool): CoderAdapter {
  return {
    name: tool,
    command: () => getCoderToolSpec(tool).command,
    preview: (ctx: CoderContext) => {
      const spec = getCoderToolSpec(tool);
      const args = materializeArgs(spec.args, '<修复提示词>');
      return [
        `编码工具：${chalk.cyan(tool)}（${spec.command}）`,
        `工作目录：${ctx.repoDir}`,
        `将执行：${chalk.dim(formatCommand(spec.command, args))}`,
      ];
    },
    run: async (ctx: CoderContext): Promise<CoderResult> => {
      const spec = getCoderToolSpec(tool);
      const args = materializeArgs(spec.args, ctx.prompt);
      logger.step(`调用 ${chalk.cyan(tool)} 修复中 ${chalk.dim(`(cwd: ${ctx.repoDir})`)} ...`);
      logEvent('info', 'coder.run', { tool, command: spec.command, cwd: ctx.repoDir });
      let r;
      try {
        r = await runCommandStream(spec.command, args, { cwd: ctx.repoDir });
      } catch (err) {
        return { ok: false, reason: `启动 ${spec.command} 失败: ${(err as Error).message}` };
      }
      if (!r.ok) {
        const tail = (r.stderr || r.stdout).trim().slice(-300);
        return { ok: false, reason: `${tool} 退出码 ${r.code ?? '?'}${tail ? `：${tail}` : ''}` };
      }
      logEvent('info', 'coder.done', { tool, code: r.code });
      return { ok: true };
    },
  };
}

const ADAPTERS: Record<CoderTool, CoderAdapter> = {
  claude: makeAdapter('claude'),
  kimi: makeAdapter('kimi'),
  opencode: makeAdapter('opencode'),
};

/** 取某工具的适配器。 */
export function getCoderAdapter(tool: CoderTool): CoderAdapter {
  return ADAPTERS[tool];
}

/** 全部工具适配器。 */
export function listCoderAdapters(): CoderAdapter[] {
  return CODER_TOOLS.map((t) => ADAPTERS[t]);
}

/**
 * 拼装修复提示词：工单标题 + 描述 + 约束。
 * 供工作流 coder.fix 步骤统一生成，保证各工具收到一致的上下文。
 */
export function buildFixPrompt(input: {
  identifier: string;
  subject: string;
  description?: string;
  files?: string[];
}): string {
  const lines = [
    `请修复以下缺陷（工单 ${input.identifier}）：`,
    `标题：${input.subject}`,
  ];
  if (input.description && input.description.trim()) {
    lines.push('', '缺陷描述：', input.description.trim());
  }
  if (input.files && input.files.length > 0) {
    lines.push('', `建议重点关注文件：${input.files.join(', ')}`);
  }
  lines.push(
    '',
    '要求：',
    '- 仅修改与该缺陷直接相关的必要文件，保持既有代码风格与约定；',
    '- 不要引入无关重构或额外依赖；',
    '- 修改后确保项目可正常构建；',
    '- 直接在当前工程目录内完成修改（无需询问确认）。'
  );
  return lines.join('\n');
}
