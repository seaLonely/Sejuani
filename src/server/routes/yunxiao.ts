import { Router, sendJson, sendError } from '../http';
import { yunxiaoConfigured } from '../../core/state/yunxiaoConfig';
import {
  addComment,
  canTransition,
  getWorkItem,
  listComments,
  listSprints,
  listWorkItems,
  updateWorkItemStatus,
} from '../../core/yunxiao/api';
import { ListQuery, WorkItemType } from '../../core/yunxiao/types';

/**
 * 云效任务看板路由：
 * - GET  /api/yunxiao/tasks                  工单列表（sprint=current 用配置默认迭代）
 * - GET  /api/yunxiao/tasks/:id              工单详情（含评论）
 * - POST /api/yunxiao/tasks/:id/transition   状态流转 { statusId }
 * - POST /api/yunxiao/tasks/:id/comment      追加评论 { content }
 * - GET  /api/yunxiao/sprints                迭代列表
 *
 * 未配置云效 PAT/组织 id 时统一返回 { configured: false }（HTTP 200），
 * 前端据此展示配置引导而非报错。
 */

/** 云效 api 抛错的状态码映射：配置类问题 400，上游接口失败 502 */
function sendYunxiaoError(res: Parameters<typeof sendError>[0], err: unknown): void {
  const msg = (err as Error).message ?? String(err);
  sendError(res, msg.includes('未配置') ? 400 : 502, msg);
}

/** 解析工单列表查询参数 */
function parseListQuery(query: URLSearchParams): ListQuery {
  const q: ListQuery = {};
  const type = query.get('type');
  if (type === 'Req' || type === 'Bug' || type === 'Task') q.type = type as WorkItemType;
  const sprintId = query.get('sprintId');
  if (sprintId) q.sprintId = sprintId;
  // sprint=all 表示不套用配置里的默认迭代/负责人筛选
  if (query.get('sprint') === 'all') q.applyDefaults = false;
  const statusName = query.get('status');
  if (statusName) q.statusName = statusName;
  const keyword = query.get('keyword');
  if (keyword) q.keyword = keyword;
  const spaceId = query.get('spaceId');
  if (spaceId) q.spaceId = spaceId;
  const limit = parseInt(query.get('limit') ?? '', 10);
  if (!Number.isNaN(limit) && limit > 0) q.limit = limit;
  return q;
}

export function registerYunxiaoRoutes(router: Router): void {
  /** 未配置 PAT/组织 id 时短路返回 { configured: false } */
  const guard = (res: Parameters<typeof sendJson>[0]): boolean => {
    if (!yunxiaoConfigured()) {
      sendJson(res, 200, { configured: false });
      return false;
    }
    return true;
  };

  // 工单列表
  router.get('/api/yunxiao/tasks', async (r) => {
    if (!guard(r.res)) return;
    try {
      sendJson(r.res, 200, await listWorkItems(parseListQuery(r.query)));
    } catch (err) {
      sendYunxiaoError(r.res, err);
    }
  });

  // 迭代列表
  router.get('/api/yunxiao/sprints', async (r) => {
    if (!guard(r.res)) return;
    try {
      sendJson(r.res, 200, await listSprints(r.query.get('spaceId') ?? undefined));
    } catch (err) {
      sendYunxiaoError(r.res, err);
    }
  });

  // 工单详情（含评论）
  router.get('/api/yunxiao/tasks/:id', async (r) => {
    if (!guard(r.res)) return;
    try {
      const item = await getWorkItem(r.params.id);
      const comments = await listComments(r.params.id);
      sendJson(r.res, 200, { ...item, comments });
    } catch (err) {
      sendYunxiaoError(r.res, err);
    }
  });

  // 状态流转
  router.post('/api/yunxiao/tasks/:id/transition', async (r) => {
    if (!guard(r.res)) return;
    const { statusId } = r.body ?? {};
    if (typeof statusId !== 'string' || !statusId.trim()) {
      sendError(r.res, 400, '缺少 statusId');
      return;
    }
    try {
      // 先取详情拿到空间/类型/当前状态，校验流转合法性
      const item = await getWorkItem(r.params.id);
      const check = await canTransition(item.spaceId, item.type, item.statusId, statusId.trim());
      if (!check.ok) {
        sendError(r.res, 409, `不允许从「${item.statusName}」流转到该状态`);
        return;
      }
      await updateWorkItemStatus(r.params.id, statusId.trim());
      sendJson(r.res, 200, { ok: true });
    } catch (err) {
      sendYunxiaoError(r.res, err);
    }
  });

  // 追加评论
  router.post('/api/yunxiao/tasks/:id/comment', async (r) => {
    if (!guard(r.res)) return;
    const { content } = r.body ?? {};
    if (typeof content !== 'string' || !content.trim()) {
      sendError(r.res, 400, '评论内容 content 不能为空');
      return;
    }
    try {
      await addComment(r.params.id, content.trim());
      sendJson(r.res, 200, { ok: true });
    } catch (err) {
      sendYunxiaoError(r.res, err);
    }
  });
}
