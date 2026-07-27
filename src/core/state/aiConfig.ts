import { maskSecret } from '../../utils/secret';
import { readState, writeState, stateFilePath } from './stateFile';

/**
 * AI 接入配置的持久化：读-合并-写回 ~/.sejuani/state.json 的 `ai` 键。
 *
 * 目标是 OpenAI / OpenAI 兼容的 chat completions 接口：自带 apiKey，
 * 可配 baseURL(默认 https://api.openai.com/v1)、model(默认 gpt-4o-mini)、temperature。
 */

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

/** state.json 中持久化的 ai 片段（均可选，读取时补默认） */
export interface AiConfigPatch {
  baseURL?: string;
  apiKey?: string;
  model?: string;
  temperature?: number;
}

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TEMPERATURE = 0;

/** 读取生效的 AI 配置（补齐默认值）。环境变量 OPENAI_API_KEY 可作为 apiKey 的兜底。 */
export function getAiConfig(): AiConfig {
  const ai = readState().ai;
  const raw: AiConfigPatch = ai && typeof ai === 'object' ? ai : {};
  return {
    baseURL: typeof raw.baseURL === 'string' && raw.baseURL.trim() ? raw.baseURL.trim() : DEFAULT_BASE_URL,
    apiKey:
      typeof raw.apiKey === 'string' && raw.apiKey.trim()
        ? raw.apiKey.trim()
        : (process.env.OPENAI_API_KEY ?? '').trim(),
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_MODEL,
    temperature: typeof raw.temperature === 'number' ? raw.temperature : DEFAULT_TEMPERATURE,
  };
}

/** 合并写回 AI 配置（保留其它字段），返回写回后的生效配置。 */
export function setAiConfig(patch: AiConfigPatch): AiConfig {
  const state = readState();
  const prev: AiConfigPatch = state.ai && typeof state.ai === 'object' ? state.ai : {};
  const next: AiConfigPatch = {
    ...prev,
    ...(patch.baseURL !== undefined ? { baseURL: patch.baseURL } : {}),
    ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.temperature !== undefined ? { temperature: patch.temperature } : {}),
  };
  state.ai = next;
  writeState(state);
  return getAiConfig();
}

/** 是否已配置可用的 apiKey（配置文件或环境变量）。 */
export function aiConfigured(): boolean {
  return getAiConfig().apiKey.length > 0;
}

/** 打码展示 apiKey，仅保留首尾少量字符。 */
export const maskApiKey = maskSecret;

/** 状态文件路径（用于提示）。 */
export function aiStateFilePath(): string {
  return stateFilePath();
}
