import { WorkflowStep } from '../workflow/types';

/**
 * Skill 一等实体（K1）：把「可复用技能」从 workflow 模板附属提升为独立实体。
 * 两种形态：
 *   - workflow 型：内嵌步骤骨架，交工作流引擎确定性执行；
 *   - prompt 型：自然语言操作指南，交 LLM 执行。
 */

export type SkillKind = 'workflow' | 'prompt';

export interface Skill {
  /** 唯一标识，[a-zA-Z0-9._-] */
  name: string;
  /** 人类可读标题 */
  title: string;
  /** 适用场景描述（供 Agent 判断何时使用） */
  description: string;
  /** 触发关键词（可选，Agent 语义匹配辅助） */
  triggers?: string[];
  kind: SkillKind;
  /** kind=workflow：步骤骨架（复用 WorkflowStep；去运行态字段） */
  steps?: WorkflowStep[];
  /** kind=prompt：交 LLM 执行的自然语言操作指南 */
  guide?: string;
  /** 关联信息（K2/U5 用；K1 仅存储不消费） */
  links?: { requirements?: string[]; skills?: string[] };
  /** 保存时间 ISO */
  savedAt: string;
}
