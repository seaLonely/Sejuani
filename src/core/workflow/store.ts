import fs from 'fs';
import os from 'os';
import path from 'path';
import { RunState, WorkflowSpec } from './types';

/**
 * 工作流持久化：spec 与运行状态(checkpoint) 落盘到 ~/.sejuani/workflows/。
 *   <id>.json         工作流定义
 *   <id>.state.json   运行状态（断点续跑用）
 */
const WORKFLOWS_DIR = path.join(os.homedir(), '.sejuani', 'workflows');

function specFile(id: string): string {
  return path.join(WORKFLOWS_DIR, `${id}.json`);
}

function stateFile(id: string): string {
  return path.join(WORKFLOWS_DIR, `${id}.state.json`);
}

/** 保存工作流定义 */
export function saveSpec(spec: WorkflowSpec): string {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  const file = specFile(spec.id);
  fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
  return file;
}

/** 读取工作流定义；不存在返回 null */
export function loadSpec(id: string): WorkflowSpec | null {
  try {
    const file = specFile(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as WorkflowSpec;
  } catch {
    return null;
  }
}

/** 写入运行状态 checkpoint */
export function saveRunState(state: RunState): void {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
  fs.writeFileSync(stateFile(state.specId), JSON.stringify(state, null, 2) + '\n');
}

/** 读取运行状态；不存在返回 null */
export function loadRunState(id: string): RunState | null {
  try {
    const file = stateFile(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RunState;
  } catch {
    return null;
  }
}

/** 列出全部已保存工作流（按创建时间倒序） */
export function listSpecs(): WorkflowSpec[] {
  try {
    if (!fs.existsSync(WORKFLOWS_DIR)) return [];
    const specs: WorkflowSpec[] = [];
    for (const f of fs.readdirSync(WORKFLOWS_DIR)) {
      if (!f.endsWith('.json') || f.endsWith('.state.json')) continue;
      try {
        specs.push(JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, f), 'utf8')) as WorkflowSpec);
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return specs.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  } catch {
    return [];
  }
}

/** 工作流目录路径（用于提示） */
export function workflowsDir(): string {
  return WORKFLOWS_DIR;
}
