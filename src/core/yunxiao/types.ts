/**
 * 云效工作项(工单)与工作流的领域类型。
 *
 * 云效 OpenAPI 各接口的实际返回字段可能随版本/项目模板不同，client/api 层
 * 会做多字段名兜底解析后归一到这里定义的结构，UI/工作流仅依赖这些稳定字段。
 */

/** 工作项类型：需求 / 缺陷 / 任务（云效工作项分类的常见三类）。 */
export type WorkItemType = 'Req' | 'Bug' | 'Task';

/** 归一后的工作项（工单）。 */
export interface WorkItem {
  /** 工作项唯一 id（云效内部 id，用于详情/评论/更新接口） */
  id: string;
  /** 可读编号（如 项目-123），用于展示；缺省回落到 id */
  identifier: string;
  /** 标题 */
  subject: string;
  /** 类型（需求/缺陷/任务） */
  type: WorkItemType;
  /** 当前状态 id */
  statusId: string;
  /** 当前状态名（如 待处理/开发中/已完成） */
  statusName: string;
  /** 负责人显示名 */
  assignedTo: string;
  /** 负责人 id（用于「只看分配给自己」筛选） */
  assignedToId: string;
  /** 所属项目/空间 id（查工作流状态、创建等需要） */
  spaceId: string;
  /** 所属迭代 id（用于按迭代筛选；可能为空） */
  sprintId?: string;
  /** 所属迭代名 */
  sprintName?: string;
  /** 详情描述（getWorkItem 才填充） */
  description?: string;
}

/** 工作项评论。 */
export interface WorkItemComment {
  id: string;
  /** 评论正文 */
  content: string;
  /** 评论人显示名 */
  author: string;
  /** 创建时间（ISO 或云效原始字符串） */
  createdAt: string;
}

/** 工作流状态节点（含允许流转到的后继状态 id）。 */
export interface WorkflowStatus {
  id: string;
  name: string;
  /** 允许流转到的后继状态 id 列表（据此校验状态跳转合法性）；为空表示未知/不限制 */
  nextStatusIds: string[];
}

/** 当前令牌对应的用户。 */
export interface CurrentUser {
  id: string;
  name: string;
}

/** 列表查询条件。 */
export interface ListQuery {
  /** 项目/空间 id；缺省用配置里的 defaultProjectId */
  spaceId?: string;
  /** 按类型过滤（不给则全部） */
  type?: WorkItemType;
  /** 只看分配给该用户 id 的工单 */
  assignedToId?: string;
  /** 按迭代 id 过滤（本地过滤） */
  sprintId?: string;
  /** 关键词（标题包含），本地过滤 */
  keyword?: string;
  /** 状态名过滤，本地过滤 */
  statusName?: string;
  /** 返回条数上限，默认 50 */
  limit?: number;
  /** 是否套用配置里的默认迭代/负责人（缺省 true）；设 false 则本次忽略默认。 */
  applyDefaults?: boolean;
}

/** 通用「id + 名称」实体（迭代/部门/成员选择用）。 */
export interface NamedEntity {
  id: string;
  name: string;
}

/** 迭代（Sprint）。 */
export interface Sprint extends NamedEntity {
  /** 状态：TODO(未开始) / DOING(进行中) / ARCHIVED(已完成) */
  status: string;
}

/** 项目成员。 */
export interface Member extends NamedEntity {
  /** 角色名（如 管理员/成员） */
  role?: string;
}

/** 创建 MR 的入参。 */
export interface CreateMergeRequestInput {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description?: string;
}

/** 创建 MR 的结果。 */
export interface MergeRequestResult {
  /** MR 在云效上的可访问地址（尽力解析，缺省为空串） */
  webUrl: string;
  /** MR 序号/iid（若可解析） */
  iid?: string;
}
