import { Component } from '../../types';
import { SejuaniConfig } from '../../config';
import { Catalog } from '../catalog';

/**
 * 工作流类型定义。工作流由 AI 规划器（planner）产出、执行引擎（engine）消费。
 * 步骤 kind 与 params 的契约见 steps.ts（步骤目录）。
 */

/** 支持的步骤类型 */
export type StepKind =
  | 'component.bump'
  | 'component.release'
  | 'project.find-users'
  | 'project.upgrade'
  | 'project.install'
  | 'git.pull'
  | 'git.merge';

/** 单个工作流步骤 */
export interface WorkflowStep {
  /** 步骤唯一 id（如 s1、bump-core），用于 dependsOn 引用与 checkpoint */
  id: string;
  kind: StepKind;
  /** 人类可读标题 */
  title: string;
  /** 步骤参数（结构由各 kind 约定，见 steps.ts） */
  params: Record<string, any>;
  /** 是否为不可逆/危险步骤（发布/合并/push），执行前需高亮并二次确认 */
  dangerous?: boolean;
  /** 依赖的前置步骤 id（拓扑排序用） */
  dependsOn?: string[];
  /** 缺失的必填参数名（如 git.merge 缺 from）；审阅时高亮、执行前需补全 */
  needsInput?: string[];
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
}

export type StepStatus = 'pending' | 'ok' | 'failed' | 'skipped';

/** 单步执行结果 */
export interface StepResult {
  id: string;
  status: StepStatus;
  reason?: string;
  startedAt?: string;
  endedAt?: string;
}

/** 一次工作流运行的状态（checkpoint 落盘用） */
export interface RunState {
  specId: string;
  results: StepResult[];
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
}
