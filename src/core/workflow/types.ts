import { Component } from '../types';
import { SejuaniConfig } from '../config';
import { Catalog } from '../catalog';
import { CoderTool } from '../state/coderConfig';
import { WorkflowStatus, WorkItem } from '../yunxiao/types';

/**
 * 工作流类型定义。工作流由 AI 规划器（planner）产出、或由云效修复流（fixBug）直接构造，由执行引擎（engine）消费。
 * 步骤 kind 与 params 的契约见 steps.ts（步骤目录）。
 */

/** 支持的步骤类型 */
export type StepKind =
  | 'component.bump'
  | 'component.release'
  | 'project.find-users'
  | 'project.upgrade'
  | 'project.install'
  | 'project.verify'
  | 'git.pull'
  | 'git.merge'
  | 'git.mr'
  | 'coder.fix'
  | 'shell.run'
  | 'notify.summary'
  | 'notify.channel'
  | 'flow.foreach'
  | 'flow.wait'
  | 'skill.invoke'
  | 'agent.task'
  | 'yunxiao.comment'
  | 'yunxiao.transition';

/** 触发器定义（W1）：缺省 manual（仅手动触发，现状行为） */
export type TriggerSpec =
  | { type: 'manual' }
  | { type: 'interval'; everyMinutes: number }
  | { type: 'cron'; expr: string }
  | {
      type: 'yunxiao.item';
      pollMinutes: number;
      filter?: { itemType?: 'Bug' | 'Req' | 'Task'; statusName?: string; assignedToMe?: boolean };
    }
  | { type: 'webhook'; path: string };

/** 单个工作流步骤 */
export interface WorkflowStep {
  /** 步骤唯一 id（如 s1、bump-core），用于 dependsOn 引用与 checkpoint */
  id: string;
  kind: StepKind;
  /** 人类可读标题 */
  title: string;
  /** 步骤参数（结构由各 kind 约定，见 steps/）；字符串值支持 {{...}} 表达式 */
  params: Record<string, any>;
  /** 是否为不可逆/危险步骤（发布/合并/push），执行前需高亮并二次确认 */
  dangerous?: boolean;
  /** 依赖的前置步骤 id（拓扑排序用） */
  dependsOn?: string[];
  /** 缺失的必填参数名（如 git.merge 缺 from）；审阅时高亮、执行前需补全 */
  needsInput?: string[];
  /** 步骤级重试策略（覆盖 kind 默认）：失败后按 delayMs 间隔最多重试 max 次 */
  retry?: { max: number; delayMs?: number };
  /** 条件跳过：命中则标记 skipped 但不中断后续步骤 */
  skipIf?: 'no-changes' | 'no-targets';
  /** 条件表达式（W3）：如 steps.s1.outputs.foundProjects；求值假值 → skipped[条件不满足] */
  when?: string;
  /** 直接上游被跳过时仍执行（缺省：上游 skipped 则本步级联跳过） */
  alwaysRun?: boolean;
}

/** 完整工作流 */
export interface WorkflowSpec {
  /** 工作流唯一 id（落盘文件名用） */
  id: string;
  title: string;
  /** 创建时间 ISO 字符串 */
  createdAt: string;
  /** 所属域（当前 activeDomain） */
  domain: string;
  steps: WorkflowStep[];
  /** 触发器（W1）；缺省 manual */
  trigger?: TriggerSpec;
  /** 触发器是否激活（对应 n8n workflow.active） */
  enabled?: boolean;
  /** 失败收尾步骤（W3）：主链任一步终态失败后顺序执行，表达式可用 {{failure.*}} */
  onFailure?: WorkflowStep[];
}

export type StepStatus = 'pending' | 'ok' | 'failed' | 'skipped';

/** 单步执行结果 */
export interface StepResult {
  id: string;
  status: StepStatus;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
  /** 步骤产物（进 checkpoint，resume 时回放到 StepContext） */
  outputs?: Record<string, unknown>;
}

/** 一次工作流运行的状态（checkpoint 落盘用） */
export interface RunState {
  specId: string;
  results: StepResult[];
  /** 运行开始/结束时间（ISO），用于耗时统计 */
  startedAt?: string;
  endedAt?: string;
}

/**
 * 执行上下文：跨步骤共享的运行时数据与已解析的域资源。
 * 例如 project.find-users 会把「使用了组件的工程」写入 ctx.foundProjects，
 * 供后续 project.upgrade / project.install / git.* 消费。
 */
export interface StepContext {
  config: SejuaniConfig;
  /** 组件库全部组件（含 name/version/dir） */
  components: Component[];
  /** 组件库 catalog（name -> version/dir） */
  catalog: Catalog;
  /** 工程根下全部工程 */
  projects: Component[];
  /** 用户在向导里选中的组件（供步骤缺省引用） */
  selectedComponents: Component[];
  /** find-users 产出的「使用了目标组件的工程」，按工程目录去重 */
  foundProjects: Component[];
  /** 是否 dry-run（预览不落盘不执行） */
  dryRun: boolean;
  /** 是否跳过危险步骤的二次确认 */
  yes: boolean;
  /** 各步骤产物（stepId -> outputs）；引擎每步后写入，notify.summary 等汇总步骤消费；resume 时由 hydrateContext 回放 */
  runOutputs?: Record<string, Record<string, unknown>>;
  /** 触发上下文（W1 调度器/webhook 触发时注入，供表达式 {{trigger.*}} 引用） */
  trigger?: { type: string; firedAt: string; item?: unknown; payload?: unknown };
  /** skill.invoke 调用栈（防循环/限深度；经 ctx 透传，任何嵌套路径包括 flow.foreach 都天然继承） */
  skillStack?: string[];
  /** 云效修复流（fix-bug）专用的运行时数据；非该流程为 undefined */
  yunxiao?: YunxiaoStepData;
}

/**
 * 云效修复流跨步骤共享的数据：coder.fix / git.mr / yunxiao.comment / yunxiao.transition
 * 都从这里读取当前工单、目标工程与产出（如 MR 链接）。
 */
export interface YunxiaoStepData {
  /** 选定的缺陷工单 */
  issue: WorkItem;
  /** 目标工程目录 */
  repoDir: string;
  /** 使用的本地编码工具 */
  coder: CoderTool;
  /** MR 目标分支（如 master/main） */
  targetBranch: string;
  /** 显式指定的云效代码库标识（缺省从 origin 解析） */
  repoId?: string;
  /** git.mr 创建并推送的工作分支 */
  workBranch?: string;
  /** git.mr 产出的 MR 链接，供后续 yunxiao.comment 引用 */
  mrUrl?: string;
  /** 缓存的工作流状态列表（首次查询后复用） */
  statuses?: WorkflowStatus[];
}
