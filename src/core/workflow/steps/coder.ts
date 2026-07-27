import { logger } from '../../../utils/logger';
import * as git from '../../git';
import { getCoderAdapter, buildFixPrompt } from '../../coder/registry';
import { StepHandler } from './contract';
import { requireYunxiao } from './helpers';

/** 编码工具步骤：调用本地 AI 编码 CLI 修复缺陷(coder.fix)。 */

export const coderFix: StepHandler = {
  kind: 'coder.fix',
  describe: () => ({
    kind: 'coder.fix',
    summary: '调用本地 AI 编码工具（claude/kimi/opencode）在目标工程内修复选定缺陷。',
    params: {
      files: '可选，建议重点关注的文件路径数组',
    },
    dangerous: false,
  }),
  preview: (step, ctx) => {
    const y = requireYunxiao(ctx);
    const adapter = getCoderAdapter(y.coder);
    const files = Array.isArray(step.params.files) ? step.params.files.map(String) : undefined;
    return [`修复工单 ${y.issue.identifier}：${y.issue.subject}`, ...adapter.preview({ repoDir: y.repoDir, prompt: '', files })];
  },
  execute: async (step, ctx) => {
    const y = requireYunxiao(ctx);
    if (!git.isGitRepo(y.repoDir)) return { ok: false, reason: `目标目录不是 git 仓库：${y.repoDir}` };
    const files = Array.isArray(step.params.files) ? step.params.files.map(String) : undefined;
    const prompt = buildFixPrompt({
      identifier: y.issue.identifier,
      subject: y.issue.subject,
      description: y.issue.description,
      files,
    });
    const adapter = getCoderAdapter(y.coder);
    const res = await adapter.run({ repoDir: y.repoDir, prompt, files });
    if (!res.ok) return { ok: false, reason: res.reason ?? '编码工具执行失败' };
    if (!git.hasChanges(y.repoDir)) {
      logger.warn('  编码工具执行完成，但工作区没有产生任何改动。');
      return { ok: true, reason: '无改动产生（后续 git.mr 将跳过）' };
    }
    return { ok: true, reason: '已产生改动' };
  },
};
