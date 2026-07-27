import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeSpec } from './planner';
import { StepContext, WorkflowSpec, WorkflowStep } from './types';

/**
 * 可复用工作流模板：把生成好的工作流存为命名模板，下次选新组件时直接套用，
 * 并按当前选中组件（影响域）重绑定，无需再次调用 AI。
 *
 *   ~/.sejuani/workflows/templates/<name>.json
 *
 * 模板只保存「骨架」（去除运行态 id/createdAt/domain），套用时经 normalizeSpec
 * 重新生成 id/dependsOn/dangerous/needsInput，得到一个可执行的 WorkflowSpec。
 */

const TEMPLATES_DIR = path.join(os.homedir(), '.sejuani', 'workflows', 'templates');

/** 模板骨架：不含运行态字段（id/createdAt/domain）。 */
export interface WorkflowTemplate {
  /** 模板名 */
  name: string;
  /** 工作流标题 */
  title: string;
  /** 步骤骨架（保留 step.id/dependsOn 以维持依赖关系） */
  steps: WorkflowStep[];
  /** 保存时间 ISO 字符串 */
  savedAt: string;
}

function templateFile(name: string): string {
  return path.join(TEMPLATES_DIR, `${name}.json`);
}

/** 校验模板名合法（避免路径穿越）。 */
function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/** 把工作流存为命名模板（去除运行态 id/createdAt/domain）。 */
export function saveTemplate(name: string, spec: WorkflowSpec): string {
  if (!isValidName(name)) {
    throw new Error(`模板名非法：${name}（仅允许字母/数字/._-）`);
  }
  fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  const tpl: WorkflowTemplate = {
    name,
    title: spec.title,
    steps: spec.steps.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      params: s.params,
      dangerous: s.dangerous,
      dependsOn: s.dependsOn,
      needsInput: s.needsInput,
    })),
    savedAt: new Date().toISOString(),
  };
  const file = templateFile(name);
  fs.writeFileSync(file, JSON.stringify(tpl, null, 2) + '\n');
  return file;
}

/** 内置巡检模板（W4）：不落盘，与用户模板合并展示；同名时用户模板优先。 */
const BUILTIN_TEMPLATES: WorkflowTemplate[] = [
  {
    name: 'patrol-yunxiao',
    title: '云效新工单巡检（AI 分类评论）',
    savedAt: 'builtin',
    steps: [
      {
        id: 'analyze',
        kind: 'agent.task',
        title: 'AI 分析新工单并分类评论',
        params: {
          goal: '阅读工单 {{trigger.item.identifier}}（标题：{{trigger.item.subject}}），判断类型与紧急度，并用 yunxiao_comment 追加一条分类评论。',
          maxRounds: 6,
        },
      },
      {
        id: 'summary',
        kind: 'notify.summary',
        title: '汇总巡检产物',
        params: {},
        dependsOn: ['analyze'],
      },
    ],
  },
  {
    name: 'daily-deps-report',
    title: '每日依赖日报（工作日 10:00）',
    savedAt: 'builtin',
    steps: [
      {
        id: 'report',
        kind: 'agent.task',
        title: 'AI 检查组件用量与过期依赖并生成日报',
        params: {
          goal: '用 repos_catalog 与 repos_deps_tree 检查组件库现状，汇总组件数量、分层与值得关注的依赖问题，输出一份简明日报。',
          maxRounds: 6,
        },
      },
      {
        id: 'summary',
        kind: 'notify.summary',
        title: '汇总日报产物',
        params: {},
        dependsOn: ['report'],
      },
    ],
  },
];

/** 读取模板（用户模板优先，其次内置）；不存在返回 null。 */
export function loadTemplate(name: string): WorkflowTemplate | null {
  try {
    const file = templateFile(name);
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowTemplate;
    }
  } catch {
    /* 落入内置查找 */
  }
  return BUILTIN_TEMPLATES.find((t) => t.name === name) ?? null;
}

/** 列出全部模板（用户模板在前，内置在后；同名去重用户优先）。 */
export function listTemplates(): WorkflowTemplate[] {
  let user: WorkflowTemplate[] = [];
  try {
    if (fs.existsSync(TEMPLATES_DIR)) {
      for (const f of fs.readdirSync(TEMPLATES_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          user.push(JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, f), 'utf8')) as WorkflowTemplate);
        } catch {
          /* 跳过损坏文件 */
        }
      }
      user = user.sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
    }
  } catch {
    user = [];
  }
  const userNames = new Set(user.map((t) => t.name));
  return [...user, ...BUILTIN_TEMPLATES.filter((t) => !userNames.has(t.name))];
}

/** 删除模板；成功返回 true。 */
export function removeTemplate(name: string): boolean {
  try {
    const file = templateFile(name);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 模板目录路径（用于提示）。 */
export function templatesDir(): string {
  return TEMPLATES_DIR;
}

/**
 * 套用模板：加载骨架 → 用当前选中组件 pkgName 重写各步 params.components →
 * 经 normalizeSpec 重新生成 id/dependsOn/dangerous/needsInput → 返回可执行 WorkflowSpec。
 * 不调用 AI（纯套用 + 按当前影响域重绑定）。
 */
export function applyTemplate(name: string, ctx: StepContext, id?: string): WorkflowSpec {
  const tpl = loadTemplate(name);
  if (!tpl) {
    throw new Error(`模板不存在：${name}（用 sjn flow template 查看列表）`);
  }
  const selectedNames = ctx.selectedComponents
    .map((c) => c.pkgName ?? c.name)
    .filter((n): n is string => !!n);

  // 重写各步 params.components 到当前选中组件（仅对原本带 components 字段的步骤生效）
  const rebound = tpl.steps.map((s) => {
    const params = { ...(s.params ?? {}) };
    if (Array.isArray(params.components) && selectedNames.length > 0) {
      params.components = selectedNames;
    }
    return {
      id: s.id,
      kind: s.kind,
      title: s.title,
      params,
      dangerous: s.dangerous,
      dependsOn: s.dependsOn,
      needsInput: s.needsInput,
    };
  });

  // 经 normalizeSpec 重新生成运行态字段（id/createdAt/domain/needsInput 等）；传入 id 时复用（与运行日志 runId 对齐）
  return normalizeSpec({ title: tpl.title, steps: rebound }, ctx, id);
}
