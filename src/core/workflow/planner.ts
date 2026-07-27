import { chatJSON, ChatMessage } from '../aiClient';
import { chalk, logger } from '../../utils/logger';
import { logEvent } from '../../utils/fileLogger';
import { describeAllSteps, isKnownKind, isDangerousByDefault } from './steps';
import { ImpactReport } from './impact';
import { StepContext, StepKind, WorkflowSpec, WorkflowStep } from './types';

/**
 * AI 规划器：把用户的自然语言描述 + 当前上下文 → 结构化 WorkflowSpec。
 * 组装含步骤目录 schema 与上下文的 prompt，调 chatJSON，然后严格校验/规整返回：
 * 拒绝未知 kind、补 id、按默认标注 dangerous、规整 dependsOn。
 */

/** 生成一个简短唯一 id（域-时间戳-随机）。也用作运行日志 runId，供外部在规划前先行开启运行日志。 */
export function genWorkflowId(prefix: string): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}-${rand}`;
}

/** 组装 system prompt：嵌入步骤目录与严格的输出要求 */
function buildSystemPrompt(): string {
  const steps = describeAllSteps();
  const catalogLines = steps.map((s) => {
    const params = Object.entries(s.params)
      .map(([k, v]) => `      - ${k}: ${v}`)
      .join('\n');
    return `  * ${s.kind}${s.dangerous ? ' [不可逆/危险]' : ''}: ${s.summary}\n    params:\n${params}`;
  });
  return [
    '你是 Sejuani CLI 的工作流规划助手。根据用户的自然语言描述，规划一条可确定性执行的工作流，只使用下列步骤类型（kind）。',
    '严格返回一个 JSON 对象，禁止任何解释性文字，结构如下：',
    '{',
    '  "title": "简短标题",',
    '  "steps": [',
    '    { "id": "s1", "kind": "<下列之一>", "title": "人类可读标题", "params": { ... }, "dependsOn": ["前置步骤id"] }',
    '  ]',
    '}',
    '',
    '可用步骤类型（kind）与参数：',
    ...catalogLines,
    '',
    '规则：',
    '- 只能使用上述 kind，禁止臆造其它 kind。',
    '- 典型全链顺序：component.bump → component.release → project.find-users → project.upgrade → project.install → git.pull/git.merge。',
    '- 若后续步骤要针对「使用了组件的工程」，必须先安排一个 project.find-users 步骤，并让后续步骤 dependsOn 它。',
    '- dependsOn 用步骤 id 表达先后依赖；无依赖可省略或给空数组。',
    '- params 只放该 kind 支持的字段；不确定的可选字段就省略，不要编造分支名等信息。',
    '- 影响范围以下方「影响范围」上下文为准（已由 sjn 确定性计算），不要自行猜测或臆造使用方/波及组件。',
    '- 若上下文列出了「上游波及组件」，通常这些组件也需要级联 bump/release，请按「建议发布层序」的底层→上层顺序安排。',
    '- git.merge 的 from（来源分支）若用户描述未给出：仍然生成该 git.merge 步骤，但把缺失字段名放进该步的 "needsInput": ["from"]，交由用户在审阅时补全（不要编造分支名，也不要省略该步骤）。',
  ].join('\n');
}

/** 组装 user prompt：描述 + 当前上下文 + 确定性影响范围 */
function buildUserPrompt(userDescription: string, ctx: StepContext, impact: ImpactReport): string {
  const selected = ctx.selectedComponents.map((c) => `${c.pkgName ?? c.name}@${c.pkgVersion ?? '?'}`);
  const affected = impact.affectedProjects.map((p) => p.pkgName ?? p.name);
  return [
    `域(domain): ${ctx.config.activeDomain}`,
    `已选中的组件(${selected.length})：${selected.length ? selected.join(', ') : '(无)'}`,
    `组件库 catalog 共 ${ctx.catalog.size} 个组件；工程根下共 ${ctx.projects.length} 个工程。`,
    '',
    '影响范围（已由 sjn 确定性计算，勿臆造）：',
    `- 受影响工程(${affected.length})：${affected.length ? affected.join(', ') : '(无)'}`,
    `- 上游波及组件(${impact.dependentComponents.length})：${impact.dependentComponents.length ? impact.dependentComponents.join(', ') : '(无)'}`,
    `- 建议发布层序（底层→上层）：${impact.releaseOrder.length ? impact.releaseOrder.join(' → ') : '(无)'}`,
    impact.crossDomainHint
      ? `- 跨域线索：${impact.zeroUserComponents.join(', ')} 在当前域无使用方（可能被其它域使用）。`
      : '- 无跨域线索。',
    '',
    '用户描述：',
    userDescription.trim(),
  ].join('\n');
}

/** 各 kind 的必填参数；缺失时写入 needsInput 交由用户审阅时补全。 */
const REQUIRED_PARAMS: Partial<Record<StepKind, string[]>> = {
  'git.merge': ['from'],
  'yunxiao.transition': ['toStatusName'],
  'yunxiao.comment': ['content'],
  'shell.run': ['command'],
  'flow.foreach': ['items'],
  'agent.task': ['goal'],
};

/** 计算一个步骤缺失的必填参数名。 */
function computeNeedsInput(kind: StepKind, params: Record<string, any>): string[] {
  const required = REQUIRED_PARAMS[kind] ?? [];
  return required.filter((k) => {
    const v = params[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim());
  });
}

/**
 * 校验并规整 AI 返回的原始对象为合法 WorkflowSpec；非法则抛错（附原始返回供排查）。
 * 可传入 id 复用（如规划前已采番的 runId），缺省则新生成，确保 spec.id 与运行日志文件名一致。
 */
export function normalizeSpec(raw: any, ctx: StepContext, id?: string): WorkflowSpec {
  const rawText = JSON.stringify(raw, null, 2);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) {
    throw new Error(`AI 返回缺少 steps 数组。原始返回：\n${rawText.slice(0, 800)}`);
  }
  if (raw.steps.length === 0) {
    throw new Error('AI 规划出的工作流没有任何步骤。请调整描述后重试。');
  }

  const usedIds = new Set<string>();
  const steps: WorkflowStep[] = [];
  raw.steps.forEach((s: any, i: number) => {
    const kind = String(s?.kind ?? '');
    if (!isKnownKind(kind)) {
      throw new Error(`AI 使用了未知步骤类型 kind="${kind}"（第 ${i + 1} 步）。原始返回：\n${rawText.slice(0, 800)}`);
    }
    let id = typeof s.id === 'string' && s.id.trim() ? s.id.trim() : `s${i + 1}`;
    while (usedIds.has(id)) id = `${id}_${i + 1}`;
    usedIds.add(id);
    const params = s.params && typeof s.params === 'object' && !Array.isArray(s.params) ? s.params : {};
    const dangerous = typeof s.dangerous === 'boolean' ? s.dangerous : isDangerousByDefault(kind as StepKind);
    const dependsOn = Array.isArray(s.dependsOn)
      ? s.dependsOn.map(String).filter((d: string) => d.trim())
      : [];
    // needsInput：优先采纳 AI 给出的，再并入按必填参数计算出的缺失项（去重）
    const aiNeeds = Array.isArray(s.needsInput) ? s.needsInput.map(String).filter((n: string) => n.trim()) : [];
    const computed = computeNeedsInput(kind as StepKind, params);
    const needsInput = [...new Set([...aiNeeds, ...computed])];
    steps.push({
      id,
      kind: kind as StepKind,
      title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : `${kind}`,
      params,
      dangerous,
      dependsOn,
      needsInput: needsInput.length > 0 ? needsInput : undefined,
    });
  });

  // 规整 dependsOn：剔除指向不存在步骤的引用
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    s.dependsOn = (s.dependsOn ?? []).filter((d) => ids.has(d) && d !== s.id);
  }

  return {
    id: id ?? genWorkflowId(ctx.config.activeDomain),
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : 'AI 工作流',
    createdAt: new Date().toISOString(),
    domain: ctx.config.activeDomain,
    steps,
  };
}

/** 校验失败时回喂 LLM 自修复的最大重试次数 */
const MAX_PLAN_RETRIES = 2;

/** 调 AI 生成工作流 spec；校验失败时把错误清单回喂 LLM 重试（最多 MAX_PLAN_RETRIES 次）。 */
export async function planWorkflow(
  userDescription: string,
  ctx: StepContext,
  impact: ImpactReport,
  id?: string
): Promise<WorkflowSpec> {
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(userDescription, ctx, impact) },
  ];
  logger.step('正在请求 AI 规划工作流 ...');
  logEvent('info', 'plan.request', {
    description: userDescription,
    selected: impact.selected,
    affectedProjects: impact.affectedProjects.map((p) => p.pkgName ?? p.name),
    dependentComponents: impact.dependentComponents,
  });
  for (let attempt = 0; ; attempt++) {
    const raw = await chatJSON(messages, { role: 'planner' });
    try {
      const spec = normalizeSpec(raw, ctx, id);
      logEvent('info', 'plan.result', { specId: spec.id, title: spec.title, steps: spec.steps, attempt });
      logger.success(`AI 规划完成：${chalk.bold(spec.title)}（${spec.steps.length} 步）`);
      return spec;
    } catch (err) {
      if (attempt >= MAX_PLAN_RETRIES) throw err;
      const message = (err as Error).message;
      logEvent('warn', 'plan.retry', { attempt: attempt + 1, error: message });
      logger.warn(`AI 规划未通过校验，回喂错误重试（${attempt + 1}/${MAX_PLAN_RETRIES}）…`);
      messages.push(
        { role: 'assistant', content: JSON.stringify(raw) },
        {
          role: 'user',
          content: `你返回的工作流未通过校验：${message}\n请修正后重新返回完整 JSON（仅 JSON，结构与规则不变，禁止任何解释性文字）。`,
        }
      );
    }
  }
}
