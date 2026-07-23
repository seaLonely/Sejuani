import fs from 'fs';
import path from 'path';

/**
 * 为文件生成备份，返回备份路径。
 * 默认在原文件旁写 `<file>.bak`；若已存在则加时间戳避免覆盖。
 */
export function backupFile(filePath: string): string {
  let bak = filePath + '.bak';
  if (fs.existsSync(bak)) {
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .slice(0, 19);
    bak = `${filePath}.${ts}.bak`;
  }
  fs.copyFileSync(filePath, bak);
  return bak;
}

/** 写入文件内容（保证父目录存在） */
export function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}
