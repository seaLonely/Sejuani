/**
 * 从包根 package.json 动态读取版本，避免硬编码与实际发布版本不一致。
 * dist/<子目录>/*.js 与 src/<子目录>/*.ts 均位于包根的下级目录，
 * 编译后本文件位于 dist/utils/，向上两级即包根。
 */
export function readPkgVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../package.json').version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
