import { Command } from 'commander';
import { logger } from '../../utils/logger';
import { runFixFlow } from '../../ui/yunxiaoFlow';
import { CoderTool, isCoderTool, CODER_TOOLS } from '../../core/state/coderConfig';

interface FixOpts {
  dir?: string;
  coder?: string;
  targetBranch?: string;
  repoId?: string;
  startStatus?: string;
  doneStatus?: string;
  config?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/** 注册 fix 命令：选定 bug 单 → 本地 AI 修复 → push + 建 MR + 评论 + 状态流转。 */
export function register(program: Command): void {
  program
    .command('fix <issueId>')
    .description('对指定云效缺陷单执行 AI 辅助修复并提交 MR（走 fix-bug 工作流）')
    .option('-d, --dir <repo>', '目标工程代码目录（默认当前目录）')
    .option('--coder <tool>', `本地 AI 编码工具：${CODER_TOOLS.join(' | ')}（默认取配置）`)
    .option('--target-branch <branch>', 'MR 目标分支（默认工程当前分支）')
    .option('--repo-id <id>', '云效代码库标识（默认从 origin 解析）')
    .option('--start-status <name>', '起始状态名（默认「开发中」）')
    .option('--done-status <name>', '收尾状态名（默认「待测试」）')
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('--dry-run', '仅预览工作流，不落地', false)
    .option('-y, --yes', '跳过确认（含危险步骤，慎用）', false)
    .action(async (issueId: string, opts: FixOpts) => {
      let coder: CoderTool | undefined;
      if (opts.coder) {
        if (!isCoderTool(opts.coder)) {
          logger.error(`未知编码工具: ${opts.coder}。可用: ${CODER_TOOLS.join(' / ')}`);
          process.exitCode = 1;
          return;
        }
        coder = opts.coder;
      }
      const ok = await runFixFlow({
        issueId,
        repoDir: opts.dir ?? process.cwd(),
        coder,
        targetBranch: opts.targetBranch,
        repoId: opts.repoId,
        startStatus: opts.startStatus,
        doneStatus: opts.doneStatus,
        configPath: opts.config,
        dryRun: opts.dryRun,
        yes: opts.yes,
      });
      if (!ok) process.exitCode = 1;
    });
}
