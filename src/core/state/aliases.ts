import { readState, writeState, stateFilePath } from './stateFile';

/**
 * 自定义短链(alias)持久化：与域状态共用 ~/.sejuani/state.json。
 * 形如 { "r": "release --no-build" }，运行 `sjn r [额外参数]` 会展开为
 * `sjn release --no-build [额外参数]`，方便记忆长命令。
 */

/** 读取全部短链 */
export function getAliases(): Record<string, string> {
  const a = readState().aliases;
  return a && typeof a === 'object' ? a : {};
}

/** 新增/更新一个短链（合并写回，保留 activeDomain 等其它字段） */
export function setAlias(name: string, command: string): void {
  const state = readState();
  const aliases = state.aliases && typeof state.aliases === 'object' ? state.aliases : {};
  aliases[name] = command;
  state.aliases = aliases;
  writeState(state);
}

/** 删除一个短链；不存在返回 false */
export function removeAlias(name: string): boolean {
  const state = readState();
  if (!state.aliases || !(name in state.aliases)) return false;
  delete state.aliases[name];
  writeState(state);
  return true;
}

/** 把命令字符串切分为 argv 片段，支持简单的单/双引号 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * 若 rawArgs 首个 token 命中短链，则展开为「短链命令 + 其余参数」。
 * - reserved：内置命令名集合，命中时不展开（避免短链遮蔽内置命令）。
 * - 支持短链指向另一个短链（最多展开 10 层，带环路保护）。
 */
export function expandAlias(rawArgs: string[], reserved: Set<string>): string[] {
  if (rawArgs.length === 0) return rawArgs;
  const aliases = getAliases();
  let args = rawArgs.slice();
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const head = args[0];
    if (reserved.has(head)) break; // 内置命令优先
    const mapped = aliases[head];
    if (!mapped || seen.has(head)) break;
    seen.add(head);
    args = [...tokenize(mapped), ...args.slice(1)];
  }
  return args;
}

/** 状态文件路径（用于提示） */
export function aliasStateFilePath(): string {
  return stateFilePath();
}
