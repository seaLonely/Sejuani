import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 云效(Yunxiao)接入配置的持久化：镜像 aiConfig 的读-合并-写回模式，
 * 与 AI/域状态/registry 覆盖/短链/虚拟空间共用 ~/.sejuani/state.json 的 `yunxiao` 键。
 *
 * 直连云效 OpenAPI（devops）：需要个人访问令牌(PAT) + 企业(organization) id。
 * endpoint 默认云效 OpenAPI 网关 openapi-rdc.aliyuncs.com。
 */
const STATE_DIR = path.join(os.homedir(), '.sejuani');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export interface YunxiaoConfig {
  /** OpenAPI 网关域名（不含协议），默认 openapi-rdc.aliyuncs.com */
  endpoint: string;
  /** 企业(组织) id */
  organizationId: string;
  /** 个人访问令牌(PAT)；未设置时为空串，yunxiaoConfigured() 返回 false */
  personalAccessToken: string;
  /** 可选：默认项目/空间 id（列表工单时缺省用） */
  defaultProjectId?: string;
}

/** state.json 中持久化的 yunxiao 片段（均可选，读取时补默认） */
interface YunxiaoConfigPatch {
  endpoint?: string;
  organizationId?: string;
  personalAccessToken?: string;
  defaultProjectId?: string;
}

interface SejuaniState {
  yunxiao?: YunxiaoConfigPatch;
  [key: string]: unknown;
}

const DEFAULT_ENDPOINT = 'openapi-rdc.aliyuncs.com';

function readState(): SejuaniState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SejuaniState;
  } catch {
    return {};
  }
}

function writeState(state: SejuaniState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/**
 * 读取生效的云效配置（补齐默认值）。
 * 环境变量兜底：YUNXIAO_TOKEN(PAT)、YUNXIAO_ORG_ID(组织 id)、YUNXIAO_ENDPOINT(网关)。
 */
export function getYunxiaoConfig(): YunxiaoConfig {
  const raw = readState().yunxiao;
  const y = raw && typeof raw === 'object' ? raw : {};
  return {
    endpoint:
      typeof y.endpoint === 'string' && y.endpoint.trim()
        ? y.endpoint.trim()
        : (process.env.YUNXIAO_ENDPOINT ?? DEFAULT_ENDPOINT).trim(),
    organizationId:
      typeof y.organizationId === 'string' && y.organizationId.trim()
        ? y.organizationId.trim()
        : (process.env.YUNXIAO_ORG_ID ?? '').trim(),
    personalAccessToken:
      typeof y.personalAccessToken === 'string' && y.personalAccessToken.trim()
        ? y.personalAccessToken.trim()
        : (process.env.YUNXIAO_TOKEN ?? '').trim(),
    defaultProjectId:
      typeof y.defaultProjectId === 'string' && y.defaultProjectId.trim() ? y.defaultProjectId.trim() : undefined,
  };
}

/** 合并写回云效配置（保留其它字段），返回写回后的生效配置。 */
export function setYunxiaoConfig(patch: YunxiaoConfigPatch): YunxiaoConfig {
  const state = readState();
  const prev = state.yunxiao && typeof state.yunxiao === 'object' ? state.yunxiao : {};
  const next: YunxiaoConfigPatch = {
    ...prev,
    ...(patch.endpoint !== undefined ? { endpoint: patch.endpoint } : {}),
    ...(patch.organizationId !== undefined ? { organizationId: patch.organizationId } : {}),
    ...(patch.personalAccessToken !== undefined ? { personalAccessToken: patch.personalAccessToken } : {}),
    ...(patch.defaultProjectId !== undefined ? { defaultProjectId: patch.defaultProjectId } : {}),
  };
  state.yunxiao = next;
  writeState(state);
  return getYunxiaoConfig();
}

/** 是否已配置可用的 PAT 与 组织 id（配置文件或环境变量）。 */
export function yunxiaoConfigured(): boolean {
  const c = getYunxiaoConfig();
  return c.personalAccessToken.length > 0 && c.organizationId.length > 0;
}

/** 打码展示令牌，仅保留首尾少量字符。 */
export function maskToken(token: string): string {
  if (!token) return '(未设置)';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

/** 状态文件路径（用于提示）。 */
export function yunxiaoStateFilePath(): string {
  return STATE_FILE;
}
