import { yunxiaoConfigured } from '../state/yunxiaoConfig';
import * as yunxiao from './api';

/**
 * 工单状态流转的纯逻辑（无终端打印）：供 Agent 能力与 ui/yunxiaoFlow 共用。
 * 结果用可判别联合描述，展示层各自决定如何呈现。
 */

/** 云效未配置时的统一提示文案。 */
export const YUNXIAO_CONFIG_HINT =
  '尚未配置云效。请先执行： sjn yunxiao-config set-token <token> 与 set-org <组织id>。（也可用环境变量 YUNXIAO_TOKEN / YUNXIAO_ORG_ID。）';

export type TransitionOutcome =
  | { status: 'not-configured' }
  | { status: 'no-such-status'; target: string; available: string[] }
  | { status: 'already'; identifier: string; target: string }
  | { status: 'illegal'; from: string; target: string }
  | { status: 'done'; identifier: string; from: string; target: string }
  | { status: 'error'; message: string };

/** 流转是否达成目标状态（含「本就处于目标状态」）。 */
export function isTransitionOk(o: TransitionOutcome): boolean {
  return o.status === 'done' || o.status === 'already';
}

/**
 * 快速流转工单状态：取工单 → 校验目标状态存在且流转合法 → 更新。
 * 全程不抛异常，任何失败都折叠为对应的 Outcome。
 */
export async function transitionWorkItem(
  issueId: string,
  targetStatusName: string
): Promise<TransitionOutcome> {
  if (!yunxiaoConfigured()) return { status: 'not-configured' };
  try {
    const issue = await yunxiao.getWorkItem(issueId);
    const statuses = await yunxiao.listWorkflowStatuses(issue.spaceId, issue.type);
    const targetId = yunxiao.findStatusIdByName(statuses, targetStatusName);
    if (!targetId) {
      return { status: 'no-such-status', target: targetStatusName, available: statuses.map((s) => s.name) };
    }
    if (targetId === issue.statusId) {
      return { status: 'already', identifier: issue.identifier, target: targetStatusName };
    }
    const chk = await yunxiao.canTransition(issue.spaceId, issue.type, issue.statusId, targetId);
    if (!chk.ok) {
      return { status: 'illegal', from: issue.statusName, target: targetStatusName };
    }
    await yunxiao.updateWorkItemStatus(issue.id, targetId);
    return { status: 'done', identifier: issue.identifier, from: issue.statusName, target: targetStatusName };
  } catch (err) {
    return { status: 'error', message: (err as Error).message };
  }
}
