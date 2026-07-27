import { maskSecret } from '../../utils/secret';
import { readState, writeState, stateFilePath } from './stateFile';

/**
 * 云效(Yunxiao)接入配置的持久化：读-合并-写回 ~/.sejuani/state.json 的 `yunxiao` 键。
 *
 * 直连云效 OpenAPI（devops）：需要个人访问令牌(PAT) + 企业(organization) id。
 * endpoint 默认云效 OpenAPI 网关 openapi-rdc.aliyuncs.com。
 */

export interface YunxiaoConfig {
  /** OpenAPI 网关域名（不含协议），默认 openapi-rdc.aliyuncs.com */
  endpoint: string;
  /** 企业(组织) id */
  organizationId: string;
  /** 个人访问令牌(PAT)；未设置时为空串，yunxiaoConfigured() 返回 false */
  personalAccessToken: string;
  /** 可选：默认项目/空间 id（列表工单时缺省用） */
  defaultProjectId?: string;
  /** 可选：默认迭代 id 与名称（筛选工单列表用） */
  defaultSprintId?: string;
  defaultSprintName?: string;
  /** 可选：默认团队（组织部门）id 与名称 */
  defaultTeamId?: string;
  defaultTeamName?: string;
  /** 可选：默认负责人 id 与名称（筛选工单列表用） */
  defaultAssigneeId?: string;
  defaultAssigneeName?: string;
}

/** state.json 中持久化的 yunxiao 片段（均可选，读取时补默认） */
export interface YunxiaoConfigPatch {
  endpoint?: string;
  organizationId?: string;
  personalAccessToken?: string;
  defaultProjectId?: string;
  defaultSprintId?: string;
  defaultSprintName?: string;
  defaultTeamId?: string;
  defaultTeamName?: string;
  defaultAssigneeId?: string;
  defaultAssigneeName?: string;
}

const DEFAULT_ENDPOINT = 'openapi-rdc.aliyuncs.com';

/** 取可选字符串：非空字符串则 trim 后返回，否则 undefined。 */
function optStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * 读取生效的云效配置（补齐默认值）。
 * 环境变量兜底：YUNXIAO_TOKEN(PAT)、YUNXIAO_ORG_ID(组织 id)、YUNXIAO_ENDPOINT(网关)。
 */
export function getYunxiaoConfig(): YunxiaoConfig {
  const raw = readState().yunxiao;
  const y: YunxiaoConfigPatch = raw && typeof raw === 'object' ? raw : {};
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
    defaultSprintId: optStr(y.defaultSprintId),
    defaultSprintName: optStr(y.defaultSprintName),
    defaultTeamId: optStr(y.defaultTeamId),
    defaultTeamName: optStr(y.defaultTeamName),
    defaultAssigneeId: optStr(y.defaultAssigneeId),
    defaultAssigneeName: optStr(y.defaultAssigneeName),
  };
}

/**
 * 合并写回云效配置（保留其它字段），返回写回后的生效配置。
 * 语义：patch 中「出现的键」都会被应用——值为字符串则覆盖，值为 undefined 则清除该字段；
 * 未出现的键保持原值不变。
 */
export function setYunxiaoConfig(patch: YunxiaoConfigPatch): YunxiaoConfig {
  const state = readState();
  const prev: YunxiaoConfigPatch = state.yunxiao && typeof state.yunxiao === 'object' ? state.yunxiao : {};
  const next: YunxiaoConfigPatch = { ...prev };
  for (const key of Object.keys(patch) as (keyof YunxiaoConfigPatch)[]) {
    const v = patch[key];
    if (v === undefined) delete next[key];
    else next[key] = v;
  }
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
export const maskToken = maskSecret;

/** 状态文件路径（用于提示）。 */
export function yunxiaoStateFilePath(): string {
  return stateFilePath();
}
