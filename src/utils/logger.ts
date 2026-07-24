import chalk from 'chalk';

/** 去除 ANSI 颜色转义后计算显示宽度（避免为对齐引入 string-width 依赖）。 */
function displayWidth(str: string): number {
  return str.replace(/\u001b\[[0-9;]*m/g, '').length;
}

/** 按显示宽度右侧补齐到目标宽度（忽略颜色转义占位）。 */
function padEndVisual(str: string, width: number): string {
  const pad = width - displayWidth(str);
  return pad > 0 ? str + ' '.repeat(pad) : str;
}

export const logger = {
  info(msg: string): void {
    console.log(msg);
  },
  step(msg: string): void {
    console.log(chalk.cyan('▸ ') + msg);
  },
  success(msg: string): void {
    console.log(chalk.green('✔ ') + msg);
  },
  warn(msg: string): void {
    console.log(chalk.yellow('⚠ ') + msg);
  },
  error(msg: string): void {
    console.error(chalk.red('✖ ') + msg);
  },
  title(msg: string): void {
    console.log('\n' + chalk.bold.magenta(msg));
  },
  dim(msg: string): void {
    console.log(chalk.dim(msg));
  },

  /** 标准分节标题（等价 title，语义更清晰的别名）。 */
  section(msg: string): void {
    console.log('\n' + chalk.bold.magenta(msg));
  },

  /** 浅色提示行（统一散落的 logger.info(chalk.dim(...))）。 */
  hint(msg: string): void {
    console.log(chalk.dim(msg));
  },

  /** 列表项：默认缩进 2 空格。 */
  item(text: string, opts: { indent?: number } = {}): void {
    console.log(' '.repeat(opts.indent ?? 2) + text);
  },

  /** 带符号的列表项。 */
  bullet(text: string, opts: { indent?: number } = {}): void {
    console.log(' '.repeat(opts.indent ?? 2) + chalk.dim('• ') + text);
  },

  /**
   * 键值对齐输出：按最长 label 右侧补齐，渲染 `label : value`。
   * label 用 dim，value 保留原色。
   */
  keyValue(rows: [string, string][], opts: { indent?: number } = {}): void {
    const indent = ' '.repeat(opts.indent ?? 2);
    const width = rows.reduce((m, [k]) => Math.max(m, displayWidth(k)), 0);
    for (const [k, v] of rows) {
      console.log(`${indent}${chalk.dim(padEndVisual(k, width))}  ${v}`);
    }
  },

  /**
   * 纯手写列宽表格：取每列最大显示宽度对齐输出，表头 dim。
   * 各单元格允许携带颜色转义，对齐按去色后宽度计算。
   */
  table(headers: string[], rows: string[][], opts: { indent?: number } = {}): void {
    const indent = ' '.repeat(opts.indent ?? 2);
    const widths = headers.map((h, i) =>
      Math.max(displayWidth(h), ...rows.map((r) => displayWidth(r[i] ?? '')))
    );
    const renderRow = (cells: string[], dimCell = false): string =>
      cells
        .map((c, i) => {
          const padded = padEndVisual(c ?? '', widths[i]);
          return i === cells.length - 1 ? (c ?? '') : padded;
        })
        .map((c) => (dimCell ? chalk.dim(c) : c))
        .join('  ');
    console.log(indent + renderRow(headers, true));
    for (const row of rows) console.log(indent + renderRow(row));
  },
};

export { chalk };
