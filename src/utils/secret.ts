/** 打码展示密钥/令牌，仅保留首尾少量字符。 */
export function maskSecret(secret: string): string {
  if (!secret) return '(未设置)';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}****${secret.slice(-4)}`;
}
