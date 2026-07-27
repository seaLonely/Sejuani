import { maskSecret } from '../../utils/secret';
import { readState, writeState, stateFilePath } from './stateFile';

/**
 * AI 接入配置的持久化：读-合并-写回 ~/.sejuani/state.json 的 `ai` 键。
 *
 * S1 多模型：支持命名 profile（多套 baseURL/apiKey/model）与场景角色绑定
 * （chat/planner/compress/agentTask 各用其宜）。旧的扁平字段自动迁移为名为
 * `default` 的 profile，保证向后兼容。协议统一 OpenAI 兼容 chat completions。
 */

/** 场景角色：不同用途可绑定不同 profile */
export type AiRole = 'chat' | 'planner' | 'compress' | 'agentTask';

export interface AiConfig {
  /** chat completions 的 base（不含 /chat/completions），默认 https://api.openai.com/v1 */
  baseURL: string;
  /** OpenAI(兼容) API Key；未设置时为空串，aiConfigured() 返回 false */
  apiKey: string;
  /** 模型名，默认 gpt-4o-mini */
  model: string;
  /** 采样温度，默认 0（工作流规划要稳定可复现） */
  temperature: number;
}

/** 命名 profile（一套模型接入） */
export interface AiProfile {
  baseURL: string;
  apiKey: string;
  model: string;
}

/** state.json 中持久化的 ai 片段 */
export interface AiConfigState {
  /** 旧扁平字段（迁移兼容，读取时并入 default profile） */
  baseURL?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
  /** 命名 profile 表 */
  profiles?: Record<string, AiProfile>;
  /** 主对话缺省 profile 名 */
  activeProfile?: string;
  /** 场景角色 → profile 名 绑定 */
  roles?: Partial<Record<AiRole, string>>;
}

export interface AiConfigPatch {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_PROFILE = 'default';

function readAiState(): AiConfigState {
  const ai = readState().ai;
  return ai && typeof ai === 'object' ? (ai as AiConfigState) : {};
}

/**
 * 规范化：把状态解析为 { profiles, activeProfile, roles, temperature }。
 * 迁移：若无 profiles 但有旧扁平字段（或全空），构造 default profile。
 */
function normalize(raw: AiConfigState): Required<Pick<AiConfigState, 'profiles' | 'activeProfile' | 'roles' | 'temperature'>> {
  const profiles: Record<string, AiProfile> = { ...(raw.profiles ?? {}) };
  // 迁移旧扁平字段为 default profile（仅当 default 不存在时）
  if (!profiles[DEFAULT_PROFILE]) {
    profiles[DEFAULT_PROFILE] = {
      baseURL: typeof raw.baseURL === 'string' && raw.baseURL.trim() ? raw.baseURL.trim() : DEFAULT_BASE_URL,
      apiKey: typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '',
      model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    };
  }
  const activeProfile = raw.activeProfile && profiles[raw.activeProfile] ? raw.activeProfile : DEFAULT_PROFILE;
  return {
    profiles,
    activeProfile,
    roles: raw.roles ?? {},
    temperature: typeof raw.temperature === 'number' ? raw.temperature : DEFAULT_TEMPERATURE,
  };
}

/** 把 profile 展开为生效的扁平 AiConfig（apiKey 支持环境变量兜底）。 */
function toAiConfig(p: AiProfile, temperature: number): AiConfig {
  return {
    baseURL: p.baseURL && p.baseURL.trim() ? p.baseURL.trim() : DEFAULT_BASE_URL,
    apiKey: p.apiKey && p.apiKey.trim() ? p.apiKey.trim() : (process.env.OPENAI_API_KEY ?? '').trim(),
    model: p.model && p.model.trim() ? p.model.trim() : DEFAULT_MODEL,
    temperature,
  };
}

/**
 * 读取生效的 AI 配置（补齐默认值）。
 * @param role 可选场景角色：按 roles 绑定解析 profile，未绑定回退 activeProfile。
 */
export function getAiConfig(role?: AiRole): AiConfig {
  const norm = normalize(readAiState());
  let profileName = norm.activeProfile;
  if (role && norm.roles[role] && norm.profiles[norm.roles[role]!]) {
    profileName = norm.roles[role]!;
  }
  const profile = norm.profiles[profileName] ?? norm.profiles[DEFAULT_PROFILE];
  return toAiConfig(profile, norm.temperature);
}

/** 合并写回 AI 配置（改写 activeProfile 指向的 profile），返回写回后的生效配置。 */
export function setAiConfig(patch: AiConfigPatch): AiConfig {
  const state = readState();
  const raw: AiConfigState = state.ai && typeof state.ai === 'object' ? (state.ai as AiConfigState) : {};
  const norm = normalize(raw);
  const target = norm.activeProfile;
  const prev = norm.profiles[target];
  norm.profiles[target] = {
    baseURL: patch.baseURL !== undefined ? patch.baseURL : prev.baseURL,
    apiKey: patch.apiKey !== undefined ? patch.apiKey : prev.apiKey,
    model: patch.model !== undefined ? patch.model : prev.model,
  };
  const next: AiConfigState = {
    profiles: norm.profiles,
    activeProfile: norm.activeProfile,
    roles: norm.roles,
    temperature: patch.temperature !== undefined ? patch.temperature : norm.temperature,
  };
  state.ai = next;
  writeState(state);
  return getAiConfig();
}

// ──── S1 profile / role 管理 ────

/** 列出全部 profile（含当前激活标记） */
export function listProfiles(): { name: string; profile: AiProfile; active: boolean }[] {
  const norm = normalize(readAiState());
  return Object.entries(norm.profiles).map(([name, profile]) => ({
    name,
    profile,
    active: name === norm.activeProfile,
  }));
}

/** 新增/覆写一个命名 profile */
export function upsertProfile(name: string, profile: AiProfile): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`profile 名非法：${name}（仅允许字母/数字/._-）`);
  const state = readState();
  const norm = normalize((state.ai as AiConfigState) ?? {});
  norm.profiles[name] = {
    baseURL: profile.baseURL?.trim() || DEFAULT_BASE_URL,
    apiKey: profile.apiKey?.trim() ?? '',
    model: profile.model?.trim() || DEFAULT_MODEL,
  };
  state.ai = { profiles: norm.profiles, activeProfile: norm.activeProfile, roles: norm.roles, temperature: norm.temperature };
  writeState(state);
}

/** 切换激活 profile */
export function useProfile(name: string): void {
  const state = readState();
  const norm = normalize((state.ai as AiConfigState) ?? {});
  if (!norm.profiles[name]) throw new Error(`profile 不存在：${name}`);
  state.ai = { profiles: norm.profiles, activeProfile: name, roles: norm.roles, temperature: norm.temperature };
  writeState(state);
}

/** 删除 profile（不可删 default 或当前激活） */
export function removeProfile(name: string): boolean {
  if (name === DEFAULT_PROFILE) throw new Error('不可删除 default profile');
  const state = readState();
  const norm = normalize((state.ai as AiConfigState) ?? {});
  if (name === norm.activeProfile) throw new Error(`不可删除当前激活的 profile：${name}（请先切换）`);
  if (!norm.profiles[name]) return false;
  delete norm.profiles[name];
  // 清理指向它的角色绑定
  for (const r of Object.keys(norm.roles) as AiRole[]) {
    if (norm.roles[r] === name) delete norm.roles[r];
  }
  state.ai = { profiles: norm.profiles, activeProfile: norm.activeProfile, roles: norm.roles, temperature: norm.temperature };
  writeState(state);
  return true;
}

/** 绑定场景角色到 profile（profile 为空则解绑） */
export function setRole(role: AiRole, profileName: string | null): void {
  const state = readState();
  const norm = normalize((state.ai as AiConfigState) ?? {});
  if (profileName && !norm.profiles[profileName]) throw new Error(`profile 不存在：${profileName}`);
  if (profileName) norm.roles[role] = profileName;
  else delete norm.roles[role];
  state.ai = { profiles: norm.profiles, activeProfile: norm.activeProfile, roles: norm.roles, temperature: norm.temperature };
  writeState(state);
}

/** 读取当前角色绑定表 */
export function getRoles(): Partial<Record<AiRole, string>> {
  return normalize(readAiState()).roles;
}

/** 是否已配置可用的 apiKey（当前激活 profile 或环境变量）。 */
export function aiConfigured(): boolean {
  return getAiConfig().apiKey.length > 0;
}

/** 打码展示 apiKey，仅保留首尾少量字符。 */
export const maskApiKey = maskSecret;

/** 状态文件路径（用于提示）。 */
export function aiStateFilePath(): string {
  return stateFilePath();
}
