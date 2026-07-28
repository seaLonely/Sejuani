import { chalk } from './logger';

/**
 * 轻量思考指示器（零依赖，TTY 感知）。参考 Claude Code / opencode 的"生成中"反馈。
 * 单行动画帧，stop 时清行；非 TTY 下静默（不刷屏，适配管道/CI）。
 */
export interface Spinner {
  stop(): void;
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

class NoopSpinner implements Spinner {
  stop(): void {}
}

class TtySpinner implements Spinner {
  private timer: NodeJS.Timeout;
  private frame = 0;
  private readonly startAt = Date.now();

  constructor(private readonly label: string) {
    this.render();
    this.timer = setInterval(() => this.render(), 90);
    // 不阻止进程退出
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  private render(): void {
    const secs = ((Date.now() - this.startAt) / 1000).toFixed(0);
    const line = `${chalk.cyan(FRAMES[this.frame])} ${chalk.dim(`${this.label}… ${secs}s`)}`;
    this.frame = (this.frame + 1) % FRAMES.length;
    process.stdout.write('\r\x1b[K' + line);
  }

  stop(): void {
    clearInterval(this.timer);
    process.stdout.write('\r\x1b[K'); // 清除 spinner 行
  }
}

/** 启动一个思考指示器；非 TTY 返回静默实现。 */
export function startSpinner(label = '思考中'): Spinner {
  if (!process.stdout.isTTY) return new NoopSpinner();
  return new TtySpinner(label);
}
