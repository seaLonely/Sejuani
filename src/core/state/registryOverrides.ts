import { readState, writeState, stateFilePath } from './stateFile';

/**
 * registry 地址覆盖的持久化：按域(domain)分别记住 pack / publish 地址，
 * 与域状态/短链/虚拟空间共用 ~/.sejuani/state.json。
 *
 * 生效优先级（见 config/loader.applyActiveDomain）：
 *   state.json 的 registryOverrides[域] > sejuani.config.json 显式 registries > 域内置默认。
 * release / sync 等走 pack/publish 的命令都会自动读取生效后的 config.registries。
 */

/** 单个域的 registry 覆盖（pack / publish 可分别设置） */
export interface RegistryOverride {
  pack?: string;
  publish?: string;
}

/** 读取全部域的 registry 覆盖 */
export function getAllRegistryOverrides(): Record<string, RegistryOverride> {
  const v = readState().registryOverrides;
  return v && typeof v === 'object' ? (v as Record<string, RegistryOverride>) : {};
}

/** 读取某个域的 registry 覆盖；未设置返回 undefined */
export function getRegistryOverride(domain: string): RegistryOverride | undefined {
  return getAllRegistryOverrides()[domain];
}

/** 设置某个域的 pack 或 publish 地址（合并写回，保留其它字段） */
export function setRegistry(
  domain: string,
  patch: { pack?: string; publish?: string }
): RegistryOverride {
  const state = readState();
  const all = state.registryOverrides && typeof state.registryOverrides === 'object'
    ? (state.registryOverrides as Record<string, RegistryOverride>)
    : {};
  const prev = all[domain] ?? {};
  const next: RegistryOverride = {
    ...prev,
    ...(patch.pack !== undefined ? { pack: patch.pack } : {}),
    ...(patch.publish !== undefined ? { publish: patch.publish } : {}),
  };
  all[domain] = next;
  state.registryOverrides = all;
  writeState(state);
  return next;
}

/** 清除某个域的 registry 覆盖（回退到配置/内置默认）；不存在返回 false */
export function clearRegistryOverride(domain: string): boolean {
  const state = readState();
  if (!state.registryOverrides || !(domain in state.registryOverrides)) return false;
  delete state.registryOverrides[domain];
  writeState(state);
  return true;
}

/** 状态文件路径（用于提示） */
export function registryStateFilePath(): string {
  return stateFilePath();
}
