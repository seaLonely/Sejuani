import { chalk } from '../utils/logger';

/**
 * 轻量行级 diff。由于本工具的改动都是「原地替换」，
 * 前后行数基本一致，逐行对比即可清晰展示变化。
 * 仅打印发生变化的行及其上下文。
 */
export function renderDiff(before: string, after: string, context = 1): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const max = Math.max(a.length, b.length);

  const changedIdx: number[] = [];
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) changedIdx.push(i);
  }
  if (changedIdx.length === 0) return chalk.dim('  (无变化)');

  // 计算需要展示的行区间（含上下文）
  const show = new Set<number>();
  for (const idx of changedIdx) {
    for (let j = idx - context; j <= idx + context; j++) {
      if (j >= 0 && j < max) show.add(j);
    }
  }

  const lines: string[] = [];
  let prev = -1;
  const sorted = [...show].sort((x, y) => x - y);
  for (const i of sorted) {
    if (prev !== -1 && i > prev + 1) lines.push(chalk.dim('  ┈┈┈'));
    prev = i;
    const oldLine = a[i];
    const newLine = b[i];
    const lineNo = chalk.dim(String(i + 1).padStart(4) + ' ');
    if (oldLine === newLine) {
      lines.push('  ' + lineNo + chalk.dim(oldLine ?? ''));
    } else {
      if (oldLine !== undefined) lines.push(chalk.red('- ' + lineNo + oldLine));
      if (newLine !== undefined) lines.push(chalk.green('+ ' + lineNo + newLine));
    }
  }
  return lines.join('\n');
}
