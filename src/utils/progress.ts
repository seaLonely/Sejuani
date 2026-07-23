import chalk from 'chalk';

/**
 * 轻量进度条（零依赖，TTY 感知）。
 * - 在交互式终端渲染单行可刷新的进度条（写入 stderr，不污染 stdout 结果）。
 * - 非 TTY（管道 / 重定向）下自动降级为静默，避免刷屏。
 */
export interface ProgressBar {
  /** 完成 step 个（默认 1），可附加尾部标签 */
  tick(step?: number, label?: string): void;
  /** 直接设置当前进度 */
  update(current: number, label?: string): void;
  /** 结束并清除进度条；finalMessage 非空时另起一行打印 */
  stop(finalMessage?: string): void;
}

class NoopBar implements ProgressBar {
  tick(): void {}
  update(): void {}
  stop(finalMessage?: string): void {
    if (finalMessage) process.stderr.write(finalMessage + '\n');
  }
}

class TtyBar implements ProgressBar {
  private current = 0;
  private readonly startAt = Date.now();
  private lastRenderAt = 0;

  constructor(
    private readonly total: number,
    private readonly prefix: string,
    private readonly width = 24
  ) {
    this.render();
  }

  update(current: number, label = ''): void {
    this.current = Math.max(0, Math.min(current, this.total));
    this.render(label);
  }

  tick(step = 1, label = ''): void {
    this.update(this.current + step, label);
  }

  private render(label = ''): void {
    const now = Date.now();
    // 限制刷新频率（约每 60ms 一次），完成时强制刷新
    if (this.current < this.total && now - this.lastRenderAt < 60) return;
    this.lastRenderAt = now;

    const ratio = this.total === 0 ? 1 : this.current / this.total;
    const filled = Math.round(ratio * this.width);
    const bar = '█'.repeat(filled) + '░'.repeat(this.width - filled);
    const pct = String(Math.floor(ratio * 100)).padStart(3);
    const elapsed = (now - this.startAt) / 1000;
    const rate = this.current > 0 ? this.current / elapsed : 0;

    let line = `${this.prefix}${chalk.cyan(bar)} ${pct}% ${this.current}/${this.total}`;
    if (this.current < this.total && rate > 0) {
      const eta = (this.total - this.current) / rate;
      line += chalk.dim(` ETA ${eta.toFixed(0)}s`);
    }
    if (label) line += ' ' + chalk.dim(label);

    // \r 回到行首，\x1b[K 清除到行尾，避免残留旧内容
    process.stderr.write('\r\x1b[K' + line);
  }

  stop(finalMessage?: string): void {
    process.stderr.write('\r\x1b[K');
    if (finalMessage) process.stderr.write(finalMessage + '\n');
  }
}

/**
 * 创建进度条。非 TTY 或 total<=0 时返回静默实现。
 */
export function createProgress(total: number, prefix = ''): ProgressBar {
  if (!process.stderr.isTTY || total <= 0) return new NoopBar();
  return new TtyBar(total, prefix);
}
