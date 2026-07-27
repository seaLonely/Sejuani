import { Component } from '../types';
import { readSingleComponent } from '../discover';
import { readState, writeState, stateFilePath } from './stateFile';

/**
 * 虚拟空间(vs)持久化：与域状态/短链共用 ~/.sejuani/state.json。
 * 虚拟空间 = 一个命名的组件集合（逻辑），可从依赖树 layers.json / catalog /
 * 交互多选创建，之后用 `--vs <名>` 作为扫描目标，替代写死的域组件仓；
 * 也可用 `sjn vs link` 把它物化成软链目录。
 */

/** 虚拟空间成员 */
export interface VsMember {
  /** 目录名（basename） */
  name: string;
  /** package.json 的 name */
  pkgName?: string;
  /** 组件目录绝对路径（操作时以此为准） */
  dir: string;
}

/** 一个命名的虚拟空间 */
export interface VirtualSpace {
  name: string;
  createdAt: string;
  updatedAt: string;
  /** 来源描述，如 'catalog:chery' | 'layers:/path.json' | 'manual' */
  source?: string;
  members: VsMember[];
  /** 可选：按层划分（每层为 pkgName 数组），来自依赖树分析 */
  layers?: string[][];
  /** 可选：已物化的软链目录 */
  linkedDir?: string;
}

/** 读取全部虚拟空间 */
export function getVirtualSpaces(): Record<string, VirtualSpace> {
  const v = readState().virtualSpaces;
  return v && typeof v === 'object' ? (v as Record<string, VirtualSpace>) : {};
}

/** 读取单个虚拟空间；不存在返回 undefined */
export function getVirtualSpace(name: string): VirtualSpace | undefined {
  return getVirtualSpaces()[name];
}

/** 新增/更新一个虚拟空间（合并写回，保留 activeDomain/aliases 等其它字段） */
export function saveVirtualSpace(
  name: string,
  data: { members: VsMember[]; layers?: string[][]; source?: string; linkedDir?: string }
): VirtualSpace {
  const state = readState();
  const spaces = state.virtualSpaces && typeof state.virtualSpaces === 'object'
    ? (state.virtualSpaces as Record<string, VirtualSpace>)
    : {};
  const now = new Date().toISOString();
  const prev = spaces[name];
  const vs: VirtualSpace = {
    name,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
    source: data.source ?? prev?.source,
    members: data.members,
    layers: data.layers ?? prev?.layers,
    linkedDir: data.linkedDir ?? prev?.linkedDir,
  };
  spaces[name] = vs;
  state.virtualSpaces = spaces;
  writeState(state);
  return vs;
}

/** 更新某个虚拟空间的字段（如 linkedDir）；不存在返回 undefined */
export function patchVirtualSpace(name: string, patch: Partial<VirtualSpace>): VirtualSpace | undefined {
  const state = readState();
  const spaces = state.virtualSpaces as Record<string, VirtualSpace> | undefined;
  if (!spaces || !spaces[name]) return undefined;
  spaces[name] = { ...spaces[name], ...patch, name, updatedAt: new Date().toISOString() };
  state.virtualSpaces = spaces;
  writeState(state);
  return spaces[name];
}

/** 删除一个虚拟空间；不存在返回 false */
export function removeVirtualSpace(name: string): boolean {
  const state = readState();
  if (!state.virtualSpaces || !(name in state.virtualSpaces)) return false;
  delete state.virtualSpaces[name];
  writeState(state);
  return true;
}

/**
 * 把虚拟空间解析为 Component[]（按成员目录逐个读取 package.json）。
 * 目录已不存在的成员会被跳过并计入 missing。
 */
export function resolveVsComponents(name: string): {
  components: Component[];
  missing: string[];
} | null {
  const vs = getVirtualSpace(name);
  if (!vs) return null;
  const components: Component[] = [];
  const missing: string[] = [];
  for (const m of vs.members) {
    const comp = readSingleComponent(m.dir);
    if (comp) components.push(comp);
    else missing.push(m.name || m.dir);
  }
  return { components, missing };
}

/** 由 Component[] 构造成员列表 */
export function membersFromComponents(components: Component[]): VsMember[] {
  return components.map((c) => ({ name: c.name, pkgName: c.pkgName, dir: c.dir }));
}

/** 状态文件路径（用于提示） */
export function vsStateFilePath(): string {
  return stateFilePath();
}
