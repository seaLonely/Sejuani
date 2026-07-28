import { SejuaniConfig } from '../config';
import { ChatMessage, chatJSON, extractJsonObject } from '../aiClient';
import { WorkflowSpec, WorkflowStep } from '../workflow/types';
import { Skill, SkillKind } from './types';
import { isValidSkillName } from './store';

/**
 * skill-creator（K1.4）：把已完成的流程/对话固化为 skill。
 *  - skillFromWorkflow：workflow spec → workflow 型 skill（去运行态，保骨架）
 *  - draftSkillFromHistory：LLM 从会话轨迹总结 skill 草案（不落盘，交调用方确认）
 */

/** 从 WorkflowSpec 抽取步骤骨架（剥离运行态字段） */
function skeletonSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((s) => ({
    id: s.id,
    kind: s.kind,
    title: s.title,
    params: s.params,
    dangerous: s.dangerous,
    dependsOn: s.dependsOn,
    needsInput: s.needsInput,
    when: s.when,
    skipIf: s.skipIf,
    alwaysRun: s.alwaysRun,
  }));
}

/** 工作流 → workflow 型 skill */
export function skillFromWorkflow(
  spec: WorkflowSpec,
  meta: { name: string; title?: string; description?: string; triggers?: string[] }
): Skill {
  return {
    name: meta.name,
    title: meta.title || spec.title || meta.name,
    description: meta.description || '',
    triggers: meta.triggers,
    kind: 'workflow',
    steps: skeletonSteps(spec.steps),
    savedAt: new Date().toISOString(),
  };
}

const DRAFT_SYSTEM = [
  '你是技能提炼助手。阅读给定的对话/执行轨迹（JSON 数组），把其中可复用的操作总结为一个技能。',
  '判定：若有明确的工具步骤序列 → kind="workflow"（输出 steps）；若偏经验性自然语言操作 → kind="prompt"（输出 guide）。',
  '只返回 JSON：{"name":"kebab-case","title":"","description":"适用场景","triggers":["关键词"],"kind":"workflow|prompt","steps":[],"guide":""}。',
  'name 用小写字母数字与连字符；workflow 型必须有非空 steps，prompt 型必须有非空 guide。',
].join('\n');

/** LLM 从会话轨迹总结 skill 草案（不落盘）；最多 2 次自纠错 */
export async function draftSkillFromHistory(
  config: SejuaniConfig,
  history: ChatMessage[],
  hint?: { name?: string; preferKind?: SkillKind }
): Promise<Skill> {
  const rest = history.filter((m) => m.role === 'user' || m.role === 'assistant');
  const messages: ChatMessage[] = [
    { role: 'system', content: DRAFT_SYSTEM },
    {
      role: 'user',
      content:
        (hint?.name ? `建议技能名：${hint.name}\n` : '') +
        (hint?.preferKind ? `倾向类型：${hint.preferKind}\n` : '') +
        `对话轨迹：\n${JSON.stringify(rest).slice(0, 12000)}`,
    },
  ];
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await chatJSON(messages, { role: 'compress' });
    try {
      const obj = typeof raw === 'string' ? extractJsonObject(raw) : raw;
      const kind: SkillKind = obj.kind === 'workflow' ? 'workflow' : 'prompt';
      const name = String(obj.name ?? hint?.name ?? '').trim();
      if (!isValidSkillName(name)) throw new Error(`name 非法：${name}`);
      if (kind === 'workflow' && (!Array.isArray(obj.steps) || obj.steps.length === 0)) {
        throw new Error('workflow 型缺 steps');
      }
      if (kind === 'prompt' && (!obj.guide || !String(obj.guide).trim())) {
        throw new Error('prompt 型缺 guide');
      }
      return {
        name,
        title: String(obj.title ?? name),
        description: String(obj.description ?? ''),
        triggers: Array.isArray(obj.triggers) ? obj.triggers.map(String) : undefined,
        kind,
        steps: kind === 'workflow' ? (obj.steps as WorkflowStep[]) : undefined,
        guide: kind === 'prompt' ? String(obj.guide) : undefined,
        savedAt: new Date().toISOString(),
      };
    } catch (err) {
      lastErr = (err as Error).message;
      messages.push({ role: 'assistant', content: JSON.stringify(raw).slice(0, 2000) });
      messages.push({ role: 'user', content: `上次输出不合法：${lastErr}。请修正后只返回合法 JSON。` });
    }
  }
  throw new Error(`技能草案生成失败：${lastErr}`);
}

/** 技能固化建议阈值（Harness 完成后 toolCalls 达此值才建议固化） */
export const SKILL_SUGGEST_THRESHOLD = 3;
