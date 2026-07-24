import { genWorkflowId } from './planner';
import { WorkflowSpec, WorkflowStep } from './types';
import { WorkItem } from '../yunxiao/types';

/**
 * 云效「修复缺陷」工作流的确定性构造器（不调 AI）。
 *
 * 串起功能2/3 的端到端流程：
 *   状态→开发中 → 评论(开始) → coder.fix → git.mr → 评论(附 MR) → 状态→待测试
 * 每一步都是已注册的 StepKind，交给现有 engine 执行（含 dry-run / checkpoint /
 * 危险步骤确认 / resume）。工单信息与目标工程从 StepContext.yunxiao 读取。
 */

export interface FixBugOptions {
  /** MR 目标分支（如 master/main） */
  targetBranch: string;
  /** 起始流转状态名，默认「开发中」 */
  startStatus?: string;
  /** 收尾流转状态名，默认「待测试」 */
  doneStatus?: string;
  /** 建议编码工具重点关注的文件路径 */
  files?: string[];
  /** 复用的运行 id（与运行日志对齐）；缺省新生成 */
  id?: string;
  /** 所属域（写入 spec.domain 便于归档） */
  domain?: string;
}

/** 构造 fix-bug 工作流 spec（步骤顺序即执行顺序，dependsOn 串成单链）。 */
export function buildFixBugSpec(issue: WorkItem, opts: FixBugOptions): WorkflowSpec {
  const startStatus = opts.startStatus ?? '开发中';
  const doneStatus = opts.doneStatus ?? '待测试';
  const steps: WorkflowStep[] = [
    {
      id: 'to-dev',
      kind: 'yunxiao.transition',
      title: `状态流转 → ${startStatus}`,
      params: { toStatusName: startStatus },
      dangerous: true,
    },
    {
      id: 'note-start',
      kind: 'yunxiao.comment',
      title: '评论：开始修复',
      params: { content: '🤖 Sejuani 已开始对本工单进行自动化修复。' },
      dependsOn: ['to-dev'],
    },
    {
      id: 'fix',
      kind: 'coder.fix',
      title: '本地 AI 编码工具修复',
      params: opts.files && opts.files.length ? { files: opts.files } : {},
      dependsOn: ['note-start'],
    },
    {
      id: 'mr',
      kind: 'git.mr',
      title: '提交改动并创建 MR',
      params: { targetBranch: opts.targetBranch },
      dangerous: true,
      dependsOn: ['fix'],
    },
    {
      id: 'note-mr',
      kind: 'yunxiao.comment',
      title: '评论：附上 MR 链接',
      params: { content: '✅ 修复已提交，分支 {branch}，合并请求：{mrUrl}' },
      dependsOn: ['mr'],
    },
    {
      id: 'to-done',
      kind: 'yunxiao.transition',
      title: `状态流转 → ${doneStatus}`,
      params: { toStatusName: doneStatus },
      dangerous: true,
      dependsOn: ['note-mr'],
    },
  ];

  return {
    id: opts.id ?? genWorkflowId(opts.domain ?? 'fix'),
    title: `修复缺陷 ${issue.identifier}：${issue.subject}`,
    createdAt: new Date().toISOString(),
    domain: opts.domain ?? 'fix',
    steps,
  };
}
