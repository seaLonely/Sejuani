import { Command } from 'commander';

/**
 * CLI 公共选项组：批量编辑类命令（replace-url / set-version / set-name / upgrade 等）
 * 共享的扫描范围与写操作安全选项，避免每个子命令重复声明。
 */

/** 扫描范围选项：-c/--config、-d/--dir、--projects、--components */
export function withScanOptions(cmd: Command): Command {
  return cmd
    .option('-c, --config <file>', '指定 sejuani.config.json')
    .option('-d, --dir <dir>', '扫描目录（覆盖配置）')
    .option('--projects <dir>', '工程根目录（覆盖配置）')
    .option('--components <dir>', '组件库根目录（覆盖配置）');
}

/** 写操作安全选项：--vs、--dry-run、--no-backup、-y/--yes、--diff */
export function withWriteSafetyOptions(cmd: Command): Command {
  return cmd
    .option('--vs <name>', '使用命名虚拟空间作为目标（替代域组件仓）')
    .option('--dry-run', '仅预览不写入', false)
    .option('--no-backup', '不生成 .bak 备份')
    .option('-y, --yes', '跳过确认', false)
    .option('--diff', '显示 diff 明细', false);
}

/** 批量编辑命令的完整公共选项组（扫描范围 + 写操作安全） */
export function withBatchOptions(cmd: Command): Command {
  return withWriteSafetyOptions(withScanOptions(cmd));
}
