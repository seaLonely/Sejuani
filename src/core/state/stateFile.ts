import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AiConfigPatch } from './aiConfig';
import type { YunxiaoConfigPatch } from './yunxiaoConfig';
import type { CoderConfigPatch } from './coderConfig';
import type { VirtualSpace } from './virtualSpaces';
import type { RegistryOverride } from './registryOverrides';

/**
 * ~/.sejuani/state.json 的唯一读写基座。
 * 域状态 / 短链 / 虚拟空间 / registry 覆盖 / AI / 云效 / 编码工具
 * 七类持久化全部经由本模块读-合并-写回，各自只声明并操作自己的键。
 */

const STATE_DIR = path.join(os.homedir(), '.sejuani');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

/** state.json 的全量键集合（各命名空间片段均可选，读取时由各模块补默认） */
export interface SejuaniState {
  /** 当前激活的域（domain 命令切换） */
  activeDomain?: string;
  /** 自定义短链：名称 → 命令字符串 */
  aliases?: Record<string, string>;
  /** 命名虚拟空间集合 */
  virtualSpaces?: Record<string, VirtualSpace>;
  /** 按域的 registry 覆盖 */
  registryOverrides?: Record<string, RegistryOverride>;
  /** AI 接入配置片段 */
  ai?: AiConfigPatch;
  /** 云效接入配置片段 */
  yunxiao?: YunxiaoConfigPatch;
  /** 编码工具配置片段 */
  coder?: CoderConfigPatch;
}

/** 读取整个 state.json；文件缺失或损坏时返回空对象 */
export function readState(): SejuaniState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SejuaniState;
  } catch {
    return {};
  }
}

/** 整体写回 state.json（自动创建 ~/.sejuani 目录） */
export function writeState(state: SejuaniState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/** 状态文件路径（用于提示） */
export function stateFilePath(): string {
  return STATE_FILE;
}
