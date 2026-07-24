import { request, organizationId } from './client';
import { getYunxiaoConfig } from '../yunxiaoConfig';
import {
  CreateMergeRequestInput,
  CurrentUser,
  ListQuery,
  MergeRequestResult,
  WorkflowStatus,
  WorkItem,
  WorkItemComment,
  WorkItemType,
} from './types';

/**
 * 云效 OpenAPI 业务封装（devops，projex/组织维度）。
 *
 * 各接口路径集中在 PATHS，返回字段做多字段名兜底解析后归一到 types 里的结构，
 * 使 UI / 工作流不受云效字段命名差异影响。若真实环境路径/字段与此不同，
 * 只需集中调整本文件即可（详见方案「假设与待联调确认」）。
 */

/** 集中管理接口路径（orgId 由调用处注入）。 */
const PATHS = {
  currentUser: (org: string) => `/oapi/v1/platform/organizations/${org}/user`,
  searchWorkItems: (org: string) => `/oapi/v1/projex/organizations/${org}/workitems:search`,
  workItem: (org: string, id: string) => `/oapi/v1/projex/organizations/${org}/workitems/${id}`,
  comments: (org: string, id: string) => `/oapi/v1/projex/organizations/${org}/workitems/${id}/comments`,
  workflowStatuses: (org: string, spaceId: string) =>
    `/oapi/v1/projex/organizations/${org}/projects/${spaceId}/workitemsWorkflow/statuses`,
  mergeRequests: (org: string, repoId: string) =>
    `/oapi/v1/codeup/organizations/${org}/repositories/${encodeURIComponent(repoId)}/changeRequests`,
} as const;

/** 云效工作项类型标签（用于按类型查询/展示映射）。 */
const TYPE_LABELS: Record<WorkItemType, string> = { Req: '需求', Bug: '缺陷', Task: '任务' };

/** 中文/英文类型名 → 归一枚举。 */
function normalizeType(raw: unknown): WorkItemType {
  const s = String(raw ?? '').toLowerCase();
  if (s.includes('bug') || s.includes('缺陷') || s.includes('defect')) return 'Bug';
  if (s.includes('task') || s.includes('任务')) return 'Task';
  return 'Req';
}

/** 展示用类型中文名。 */
export function typeLabel(type: WorkItemType): string {
  return TYPE_LABELS[type];
}

/** 从对象里按候选字段名取第一个非空字符串。 */
function pick(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v);
  }
  return '';
}

/** 把云效原始工作项对象归一为 WorkItem（多字段名兜底）。 */
function toWorkItem(raw: any): WorkItem {
  const assignee = raw?.assignedTo ?? raw?.assignee ?? raw?.owner ?? {};
  const status = raw?.status ?? raw?.workflowStatus ?? {};
  return {
    id: pick(raw, ['id', 'identifier', 'workitemId', 'gmtId']),
    identifier: pick(raw, ['identifier', 'serialNumber', 'code']) || pick(raw, ['id']),
    subject: pick(raw, ['subject', 'title', 'name']),
    type: normalizeType(raw?.workitemType?.name ?? raw?.categoryId ?? raw?.type ?? raw?.workitemTypeIdentifier),
    statusId: pick(status, ['id', 'identifier']) || pick(raw, ['statusId', 'statusIdentifier']),
    statusName: pick(status, ['name', 'displayName']) || pick(raw, ['statusName', 'stageName']),
    assignedTo: typeof assignee === 'object' ? pick(assignee, ['name', 'displayName', 'nickName']) : String(assignee),
    assignedToId: typeof assignee === 'object' ? pick(assignee, ['id', 'userId']) : '',
    spaceId: pick(raw, ['spaceId', 'projectId', 'space']) || pick(raw?.space, ['id']),
    description: pick(raw, ['description', 'content']) || undefined,
  };
}

/** 从返回体里尽量取出「列表数组」（兼容多种包裹字段）。 */
function extractList(res: any): any[] {
  if (Array.isArray(res)) return res;
  return res?.workitems ?? res?.result ?? res?.data ?? res?.list ?? res?.items ?? [];
}

/** 获取当前令牌对应用户，用于「只看分配给自己」筛选。 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const org = organizationId();
  const res = await request<any>('GET', PATHS.currentUser(org));
  const u = res?.user ?? res?.result ?? res;
  return { id: pick(u, ['id', 'userId', 'accountId']), name: pick(u, ['name', 'displayName', 'nickName']) };
}

/**
 * 查询工作项列表。云效以 POST :search 接收过滤条件；类型/负责人用服务端过滤，
 * 关键词/状态名做本地过滤（避免各版本字段差异导致漏筛）。
 */
export async function listWorkItems(query: ListQuery = {}): Promise<WorkItem[]> {
  const org = organizationId();
  const spaceId = query.spaceId ?? getYunxiaoConfig().defaultProjectId;
  const limit = query.limit ?? 50;
  const conditions: Record<string, unknown> = { perPage: limit, page: 1 };
  if (spaceId) conditions.spaceId = spaceId;
  if (query.type) conditions.category = TYPE_LABELS[query.type];
  if (query.assignedToId) conditions.assignedTo = query.assignedToId;

  const res = await request<any>('POST', PATHS.searchWorkItems(org), { body: conditions });
  let items = extractList(res).map(toWorkItem);

  // 本地兜底过滤
  if (query.type) items = items.filter((w) => w.type === query.type);
  if (query.assignedToId) items = items.filter((w) => !w.assignedToId || w.assignedToId === query.assignedToId);
  if (query.statusName) items = items.filter((w) => w.statusName.includes(query.statusName!));
  if (query.keyword) {
    const kw = query.keyword.toLowerCase();
    items = items.filter((w) => w.subject.toLowerCase().includes(kw) || w.identifier.toLowerCase().includes(kw));
  }
  return items.slice(0, limit);
}

/** 获取工作项详情。 */
export async function getWorkItem(id: string): Promise<WorkItem> {
  const org = organizationId();
  const res = await request<any>('GET', PATHS.workItem(org, id));
  const raw = res?.workitem ?? res?.result ?? res;
  return toWorkItem(raw);
}

/** 列出工作项评论（按时间正序）。 */
export async function listComments(id: string): Promise<WorkItemComment[]> {
  const org = organizationId();
  const res = await request<any>('GET', PATHS.comments(org, id));
  return extractList(res).map((c: any) => ({
    id: pick(c, ['id', 'commentId']),
    content: pick(c, ['content', 'text', 'body']),
    author: pick(c?.user ?? c?.author ?? {}, ['name', 'displayName']) || pick(c, ['creator']),
    createdAt: pick(c, ['gmtCreate', 'createdAt', 'createTime']),
  }));
}

/** 向工作项追加一条评论。 */
export async function addComment(id: string, content: string): Promise<void> {
  const org = organizationId();
  await request('POST', PATHS.comments(org, id), { body: { content, formatType: 'MARKDOWN' } });
}

/** 获取某空间下工作项类型的工作流状态列表（含允许流转关系）。 */
export async function listWorkflowStatuses(spaceId: string, type: WorkItemType): Promise<WorkflowStatus[]> {
  const org = organizationId();
  const res = await request<any>('GET', PATHS.workflowStatuses(org, spaceId), { query: { category: TYPE_LABELS[type] } });
  return extractList(res).map((s: any) => ({
    id: pick(s, ['id', 'identifier', 'statusId']),
    name: pick(s, ['name', 'displayName']),
    nextStatusIds: Array.isArray(s?.nextStatusIds)
      ? s.nextStatusIds.map(String)
      : Array.isArray(s?.nextStages)
        ? s.nextStages.map((n: any) => pick(n, ['id', 'identifier']))
        : [],
  }));
}

/**
 * 校验从 fromStatusId 流转到 toStatusId 是否合法。
 * 若无法获取到明确的流转关系（nextStatusIds 全空），返回 true（不阻断，交由服务端裁决）。
 */
export async function canTransition(
  spaceId: string,
  type: WorkItemType,
  fromStatusId: string,
  toStatusId: string
): Promise<{ ok: boolean; statuses: WorkflowStatus[] }> {
  const statuses = await listWorkflowStatuses(spaceId, type);
  const from = statuses.find((s) => s.id === fromStatusId);
  const hasGraph = statuses.some((s) => s.nextStatusIds.length > 0);
  if (!hasGraph || !from) return { ok: true, statuses };
  return { ok: from.nextStatusIds.includes(toStatusId), statuses };
}

/** 更新工作项状态。 */
export async function updateWorkItemStatus(id: string, targetStatusId: string): Promise<void> {
  const org = organizationId();
  await request('PUT', PATHS.workItem(org, id), { body: { statusId: targetStatusId, propertyId: 'status' } });
}

/** 按状态名在给定状态列表里找 statusId（大小写/包含匹配）。 */
export function findStatusIdByName(statuses: WorkflowStatus[], name: string): string | undefined {
  const exact = statuses.find((s) => s.name === name);
  if (exact) return exact.id;
  const fuzzy = statuses.find((s) => s.name.includes(name) || name.includes(s.name));
  return fuzzy?.id;
}

/** 在代码库上创建合并请求(MR/变更请求)，返回 MR 地址。 */
export async function createMergeRequest(repoId: string, input: CreateMergeRequestInput): Promise<MergeRequestResult> {
  const org = organizationId();
  const res = await request<any>('POST', PATHS.mergeRequests(org, repoId), {
    body: {
      sourceBranch: input.sourceBranch,
      targetBranch: input.targetBranch,
      title: input.title,
      description: input.description ?? '',
    },
  });
  const mr = res?.changeRequest ?? res?.result ?? res;
  return { webUrl: pick(mr, ['webUrl', 'url', 'detailUrl']), iid: pick(mr, ['localId', 'iid', 'id']) || undefined };
}
