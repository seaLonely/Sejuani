import { Capability, AgentTool, ToolResult } from '../types';
import { listSkills, loadSkill, saveSkill, listSkillFiles, readSkillFile, writeSkillFile } from '../../skill/store';
import { runSkill } from '../../skill/run';
import { Skill, SkillKind } from '../../skill/types';
import { WorkflowStep } from '../../workflow/types';

/**
 * Skill 能力模块（K1.2）：让 Agent 会话内查、用、固化技能。复用 core/skill 存取与执行。
 * skill_run 复用 core/skill/run 的共享路径（与 CLI 一致）；skill_save 需确认（避免误写技能库）。
 */

const KINDS: SkillKind[] = ['workflow', 'prompt'];

const skillList: AgentTool = {
  name: 'skill_list',
  readOnly: true,
  description: '列出全部已保存技能（name/kind/description），供判断是否有可复用技能。',
  parameters: { type: 'object', properties: {} },
  async execute(): Promise<ToolResult> {
    const skills = listSkills();
    if (skills.length === 0) return { success: true, output: '（暂无技能，可用 skill_save 固化）' };
    const lines = skills.map((s) => `- ${s.name} (${s.kind}): ${s.description}`);
    return { success: true, output: lines.join('\n'), data: skills };
  },
};

const skillGet: AgentTool = {
  name: 'skill_get',
  readOnly: true,
  description: '读取单个技能详情（含步骤或操作指南）。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名' } },
    required: ['name'],
  },
  async execute(args): Promise<ToolResult> {
    const s = loadSkill(String(args.name));
    if (!s) return { success: false, output: `技能不存在：${args.name}` };
    return { success: true, output: JSON.stringify(s, null, 2), data: s };
  },
};

const skillRun: AgentTool = {
  name: 'skill_run',
  readOnly: false,
  description: '执行一个技能：workflow 型走工作流引擎（危险步骤逐一确认），prompt 型交 AI 按指南执行。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名' },
      params: { type: 'object', description: '可选参数' },
    },
    required: ['name'],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const s = loadSkill(String(args.name));
    if (!s) return { success: false, output: `技能不存在：${args.name}` };
    const r = await runSkill(ctx.config, s, {
      confirm: ctx.confirm,
      promptInput: ctx.promptInput,
      params: args.params,
    });
    return { success: r.ok, output: r.summary };
  },
};

const skillSave: AgentTool = {
  name: 'skill_save',
  needsConfirm: true,
  description:
    '把一个技能固化落盘（skill-creator）。workflow 型传 steps，prompt 型传 guide。用于把已跑通的可复用流程沉淀下来。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（字母/数字/._-）' },
      title: { type: 'string' },
      description: { type: 'string', description: '适用场景' },
      kind: { type: 'string', enum: KINDS },
      steps: { type: 'array', description: 'workflow 型：步骤数组', items: { type: 'object' } },
      guide: { type: 'string', description: 'prompt 型：操作指南' },
      triggers: { type: 'array', items: { type: 'string' } },
    },
    required: ['name', 'kind'],
  },
  async execute(args): Promise<ToolResult> {
    const kind: SkillKind = KINDS.includes(args.kind) ? args.kind : 'prompt';
    const skill: Skill = {
      name: String(args.name),
      title: args.title ? String(args.title) : String(args.name),
      description: args.description ? String(args.description) : '',
      kind,
      steps: Array.isArray(args.steps) ? (args.steps as WorkflowStep[]) : undefined,
      guide: args.guide ? String(args.guide) : undefined,
      triggers: Array.isArray(args.triggers) ? args.triggers.map(String) : undefined,
      savedAt: new Date().toISOString(),
    };
    try {
      const dir = saveSkill(skill);
      return { success: true, output: `已固化技能 ${skill.name}（${kind}）→ ${dir}` };
    } catch (err) {
      return { success: false, output: (err as Error).message };
    }
  },
};

// 渐进式披露 L2：列出/读取技能引用文件（大技能把参考料拆到 references/ 等，按需加载省 token）
const skillFiles: AgentTool = {
  name: 'skill_files',
  readOnly: true,
  description: '列出一个技能目录下的引用文件（references/templates/scripts 等），供按需读取。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: '技能名' } },
    required: ['name'],
  },
  async execute(args): Promise<ToolResult> {
    if (!loadSkill(String(args.name))) return { success: false, output: `技能不存在：${args.name}` };
    const files = listSkillFiles(String(args.name));
    return { success: true, output: files.length ? files.join('\n') : '（无引用文件）', data: files };
  },
};

const skillReadFile: AgentTool = {
  name: 'skill_read_file',
  readOnly: true,
  description: '读取技能的一个引用文件（渐进式披露 L2：只在需要时才加载该文件内容）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名' },
      file: { type: 'string', description: '引用文件相对路径（来自 skill_files）' },
    },
    required: ['name', 'file'],
  },
  async execute(args): Promise<ToolResult> {
    const content = readSkillFile(String(args.name), String(args.file));
    if (content === null) return { success: false, output: `文件不存在或路径非法：${args.file}` };
    return { success: true, output: content };
  },
};

// 增量编辑（对齐 Hermes skill_manage patch）：仅改变部分出现在工具调用中，比全量覆写省 token
const skillPatch: AgentTool = {
  name: 'skill_patch',
  needsConfirm: true,
  description: '对已有技能做增量编辑：把其指南/引用文件中的 old_string 替换为 new_string（首选，比重写整个技能省 token）。prompt 型改 guide；指定 file 时改引用文件。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名' },
      old_string: { type: 'string', description: '待替换的原文（需唯一）' },
      new_string: { type: 'string', description: '替换后的文本' },
      file: { type: 'string', description: '可选：目标引用文件相对路径；缺省改 prompt 型的 guide' },
    },
    required: ['name', 'old_string', 'new_string'],
  },
  async execute(args): Promise<ToolResult> {
    const name = String(args.name);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);
    const skill = loadSkill(name);
    if (!skill) return { success: false, output: `技能不存在：${name}` };
    // 改引用文件
    if (args.file) {
      const cur = readSkillFile(name, String(args.file));
      if (cur === null) return { success: false, output: `引用文件不存在：${args.file}` };
      if (!cur.includes(oldStr)) return { success: false, output: 'old_string 未在引用文件中找到' };
      if (cur.split(oldStr).length > 2) return { success: false, output: 'old_string 不唯一，请扩大上下文' };
      writeSkillFile(name, String(args.file), cur.replace(oldStr, newStr));
      return { success: true, output: `已更新技能 ${name} 的引用文件 ${args.file}` };
    }
    // 改 prompt 型 guide
    if (skill.kind !== 'prompt' || !skill.guide) {
      return { success: false, output: '仅 prompt 型技能可直接 patch guide；workflow 型请用 skill_save 重存或指定 file' };
    }
    if (!skill.guide.includes(oldStr)) return { success: false, output: 'old_string 未在 guide 中找到' };
    if (skill.guide.split(oldStr).length > 2) return { success: false, output: 'old_string 不唯一，请扩大上下文' };
    skill.guide = skill.guide.replace(oldStr, newStr);
    saveSkill(skill);
    return { success: true, output: `已增量更新技能 ${name} 的 guide` };
  },
};

export const skillCapability: Capability = {
  name: 'skill',
  description: '技能管理：查、执行、固化可复用技能（workflow 型/prompt 型）',
  tools: [skillList, skillGet, skillRun, skillSave, skillFiles, skillReadFile, skillPatch],
};
