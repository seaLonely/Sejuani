import { StepKind, WorkflowStep, StepContext } from '../types';

/**
 * 步骤目录的能力契约：每种 kind 的说明/预览/执行三件套。
 * - describe()：给 LLM 的 JSON schema 说明（planner 组装 prompt 用）。
 * - preview(step, ctx)：dry-run 文案（多行）。
 * - execute(step, ctx)：真实执行（引擎在非 dry-run 时调用）。
 *
 * 复用现有原语，AI 不改动发布/升级内部细节，只负责编排步骤顺序与参数。
 */

export interface StepExecResult {
  ok: boolean;
  reason?: string;
  /** 步骤产物：进 checkpoint（StepResult.outputs），resume 时回放到 StepContext */
  outputs?: Record<string, unknown>;
}

/** 供 planner 拼接 prompt 的步骤能力说明 */
export interface StepDescription {
  kind: StepKind;
  summary: string;
  /** 参数说明：字段名 -> 含义 */
  params: Record<string, string>;
  /** 该 kind 默认是否危险（不可逆） */
  dangerous: boolean;
  /** kind 级默认重试策略（网络类可安全重试的步骤声明）；步骤级 retry 优先 */
  defaultRetry?: { max: number; delayMs: number };
}

export interface StepHandler {
  kind: StepKind;
  describe(): StepDescription;
  preview(step: WorkflowStep, ctx: StepContext): string[];
  execute(step: WorkflowStep, ctx: StepContext): Promise<StepExecResult>;
}
