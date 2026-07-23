import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * registry 地址覆盖的持久化：按域(domain)分别记住 pack / publish 地址，
 * 与域状态/短链/虚拟空间共用 ~/.sejuani/state.json。
 *
 * 生效优先级（见 configLoader.applyActiveDomain）：
 *   state.json 的 registryOverrides[域] > sejuani.config.json 显式 registries > 域内置默认。
 * release / sync 等走 pack/publish 的命令都会自动读取生效后的 config.registries。
 */
const STATE_DIR = path.join(os.homedir(), '.sejuani');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/** 单个域的 registry 覆盖（pack / publish 可分别设置） */
export interface RegistryOverride {
  pack?: string;
  publish?: string;
}

interface SejuaniState {
  registryOverrides?: Record<string, RegistryOverride>;
  [key: string]: unknown;
}

function readState(): SejuaniState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SejuaniState;
  } catch {
    return {};
  }
}

function writeState(state: SejuaniState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/** 读取全部域的 registry 覆盖 */
export function getAllRegistryOverrides(): Record<string, RegistryOverride> {
  const v = readState().registryOverrides;
  return v && typeof v === 'object' ? v : {};
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
    ? state.registryOverrides
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
  return STATE_FILE;
}
