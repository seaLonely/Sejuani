import { ConfirmFn } from '../../types';
import { StepContext, StepKind, WorkflowStep } from '../types';
import * as git from '../../git';
import { StepDescription, StepHandler } from './contract';
import { componentBump, componentRelease } from './component';
import { projectFindUsers, projectUpgrade, projectInstall, projectVerify } from './project';
import { gitPull, gitMerge, gitMr } from './git';
import { coderFix } from './coder';
import { shellRun } from './shell';
import { notifySummary } from './notify';
import { notifyChannel } from './channel';
import { flowForeach, flowWait } from './flow';
import { skillInvoke } from './skill';
import { agentTask } from './agent';
import { yunxiaoComment, yunxiaoTransition } from './yunxiao';
import { resolveTargetComponents, resolveTargetProjects } from './helpers';

/**
 * 步骤目录聚合入口：按类别拆分的 handler 在此注册为 kind -> handler 表。
 * 契约类型见 ./contract，共享工具见 ./helpers。
 */

export * from './contract';

/** 全部步骤处理器（kind -> handler） */
export const STEP_HANDLERS: Record<StepKind, StepHandler> = {
  'component.bump': componentBump,
  'component.release': componentRelease,
  'project.find-users': projectFindUsers,
  'project.upgrade': projectUpgrade,
  'project.install': projectInstall,
  'project.verify': projectVerify,
  'git.pull': gitPull,
  'git.merge': gitMerge,
  'coder.fix': coderFix,
  'git.mr': gitMr,
  'shell.run': shellRun,
  'notify.summary': notifySummary,
  'notify.channel': notifyChannel,
  'flow.foreach': flowForeach,
  'flow.wait': flowWait,
  'skill.invoke': skillInvoke,
  'agent.task': agentTask,
  'yunxiao.comment': yunxiaoComment,
  'yunxiao.transition': yunxiaoTransition,
};

/** 是否已知的步骤 kind */
export function isKnownKind(kind: string): kind is StepKind {
  return Object.prototype.hasOwnProperty.call(STEP_HANDLERS, kind);
}

/** 取全部步骤的能力说明（planner 拼 prompt 用） */
export function describeAllSteps(): StepDescription[] {
  return Object.values(STEP_HANDLERS).map((h) => h.describe());
}

/** 危险步骤默认标记（planner 规整时用） */
export function isDangerousByDefault(kind: StepKind): boolean {
  return STEP_HANDLERS[kind].describe().dangerous;
}

/** 供引擎在危险步骤前二次确认（yes 时跳过）；确认回调未提供时视为拒绝 */
export async function confirmDangerous(step: WorkflowStep, confirm?: ConfirmFn): Promise<boolean> {
  if (!confirm) return false;
  return confirm(`危险步骤「${step.title}」(${step.kind}) 不可逆，确认执行?`);
}

/**
 * 评估步骤的 skipIf 条件（有限枚举，保持确定性）：
 * - no-changes：修复流工作区无改动（无 yunxiao 上下文时视为不满足）；
 * - no-targets：按 kind 解析后的目标组件/工程为空。
 * 命中返回跳过原因，未命中返回 null。
 */
export function evaluateSkipIf(step: WorkflowStep, ctx: StepContext): string | null {
  if (!step.skipIf) return null;
  if (step.skipIf === 'no-changes') {
    const repoDir = ctx.yunxiao?.repoDir;
    if (repoDir && git.isGitRepo(repoDir) && !git.hasChanges(repoDir)) {
      return '工作区无改动';
    }
    return null;
  }
  // no-targets：按 kind 前缀判断目标集合
  if (step.kind.startsWith('component.')) {
    return resolveTargetComponents(step, ctx).length === 0 ? '没有目标组件' : null;
  }
  if (step.kind.startsWith('project.') || step.kind === 'git.pull' || step.kind === 'git.merge') {
    return resolveTargetProjects(ctx).length === 0 ? '没有目标工程' : null;
  }
  return null;
}
