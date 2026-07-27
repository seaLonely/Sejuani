/**
 * 本地 AI 编码工具适配层的接口定义。
 *
 * 功能2「AI 辅助修复」把 claude / kimi / opencode 等本地 CLI 作为子进程调用：
 * Sejuani 负责拼装「修复上下文提示词」并把控流程，具体改代码由本地工具完成。
 */
import { CoderTool } from '../state/coderConfig';

/** 一次修复调用的上下文。 */
export interface CoderContext {
  /** 目标工程目录（子进程 cwd） */
  repoDir: string;
  /** 拼装好的修复提示词（含工单信息与约束） */
  prompt: string;
  /** 可选：建议聚焦的文件/路径列表（拼进提示词） */
  files?: string[];
  /** 仅预览不执行（dry-run） */
  dryRun?: boolean;
}

/** 一次修复调用的结果。 */
export interface CoderResult {
  /** 子进程是否成功退出（exit 0 或命中成功信号） */
  ok: boolean;
  /** 失败原因/摘要 */
  reason?: string;
}

/** 编码工具适配器。 */
export interface CoderAdapter {
  /** 工具名 */
  name: CoderTool;
  /** 用于展示的可执行命令名 */
  command(): string;
  /** dry-run 预览：将要执行的命令行（多行文案） */
  preview(ctx: CoderContext): string[];
  /** 真实执行：在 repoDir 下以子进程运行编码工具 */
  run(ctx: CoderContext): Promise<CoderResult>;
}
