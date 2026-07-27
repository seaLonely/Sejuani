import fs from 'fs';
import os from 'os';
import path from 'path';
import { RunState, WorkflowSpec } from './types';

/**
 * 工作流持久化：落盘到 ~/.sejuani/workflows/。
 *   <id>.json                       工作流定义
 *   <id>.state.json                 最近一次运行状态（断点续跑用，向后兼容）
 *   executions/<specId>/<execId>.json  每次执行独立存档（W2）
 *   triggers/<specId>.watermark.json   事件触发水位（W1）
 */
const WORKFLOWS_DIR = path.join(os.homedir(), '.sejuani', 'workflows');
const EXECUTIONS_DIR = path.join(WORKFLOWS_DIR, 'executions');
const TRIGGERS_DIR = path.join(WORKFLOWS_DIR, 'triggers');

/** 执行状态机（W2 定义，W3/W4 扩展 waiting / waiting-approval） */
export type ExecutionStatus = 'running' | 'ok' | 'failed' | 'interrupted' | 'waiting' | 'waiting-approval';

/** 一次执行的独立存档 */
export interface ExecutionRecord {
  execId: string;
  specId: string;
  trigger: { type: string; firedAt: string; item?: unknown; payload?: unknown };
  status: ExecutionStatus;
  state: RunState;
  startedAt: string;
  endedAt?: string;
  /** waiting 时的唤醒条件（flow.wait 落盘） */
  wakeAt?: string;
  wakeWebhook?: string;
  /** waiting-approval 时待批准的危险步骤信息 */
  pendingStep?: { id: string; title: string; kind: string };
  /** onFailure 收尾链的执行结果（W3） */
  onFailure?: Array<{ id: string; status: string; reason?: string }>;
}

/** 事件触发水位（yunxiao.item 轮询去重） */
export interface TriggerWatermark {
  seenIds: string[];
  lastPolledAt: string;
}

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

/** 已激活触发器的工作流（enabled 且非 manual） */
export function activeSpecs(): WorkflowSpec[] {
  return listSpecs().filter((s) => s.enabled && s.trigger && s.trigger.type !== 'manual');
}

// ──── 执行历史存档（W2） ────

function executionFile(specId: string, execId: string): string {
  return path.join(EXECUTIONS_DIR, specId, `${execId}.json`);
}

/** 生成执行 id */
export function genExecId(specId: string): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${specId}-${ts}-${rand}`;
}

/** 保存/更新执行存档 */
export function saveExecution(rec: ExecutionRecord): void {
  const dir = path.join(EXECUTIONS_DIR, rec.specId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(executionFile(rec.specId, rec.execId), JSON.stringify(rec, null, 2) + '\n');
}

/** 读取单次执行；不存在返回 null */
export function loadExecution(specId: string, execId: string): ExecutionRecord | null {
  try {
    const file = executionFile(specId, execId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionRecord;
  } catch {
    return null;
  }
}

/** 列出某工作流全部执行（按开始时间倒序） */
export function listExecutions(specId: string): ExecutionRecord[] {
  try {
    const dir = path.join(EXECUTIONS_DIR, specId);
    if (!fs.existsSync(dir)) return [];
    const recs: ExecutionRecord[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        recs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ExecutionRecord);
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return recs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

/** 全部工作流中处于指定状态的执行（调度器唤醒/批准队列用） */
export function listExecutionsByStatus(status: ExecutionStatus): ExecutionRecord[] {
  try {
    if (!fs.existsSync(EXECUTIONS_DIR)) return [];
    const out: ExecutionRecord[] = [];
    for (const specId of fs.readdirSync(EXECUTIONS_DIR)) {
      for (const rec of listExecutions(specId)) {
        if (rec.status === status) out.push(rec);
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  } catch {
    return [];
  }
}

/** 按 execId 全局查找执行（execId 前缀即 specId，兼容直查） */
export function findExecution(execId: string): ExecutionRecord | null {
  try {
    if (!fs.existsSync(EXECUTIONS_DIR)) return null;
    for (const specId of fs.readdirSync(EXECUTIONS_DIR)) {
      const rec = loadExecution(specId, execId);
      if (rec) return rec;
    }
    return null;
  } catch {
    return null;
  }
}

/** 清理历史：每 spec 保留最近 keep 次 */
export function pruneExecutions(specId: string, keep = 50): void {
  const recs = listExecutions(specId);
  for (const rec of recs.slice(keep)) {
    try {
      fs.unlinkSync(executionFile(specId, rec.execId));
    } catch {
      /* 忽略 */
    }
  }
}

// ──── 触发水位（W1） ────

function watermarkFile(specId: string): string {
  return path.join(TRIGGERS_DIR, `${specId}.watermark.json`);
}

/** 读水位；无则返回空 */
export function loadWatermark(specId: string): TriggerWatermark {
  try {
    const file = watermarkFile(specId);
    if (!fs.existsSync(file)) return { seenIds: [], lastPolledAt: '' };
    return JSON.parse(fs.readFileSync(file, 'utf8')) as TriggerWatermark;
  } catch {
    return { seenIds: [], lastPolledAt: '' };
  }
}

/** 写水位（seenIds 截断保留最近 500） */
export function saveWatermark(specId: string, wm: TriggerWatermark): void {
  fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
  const trimmed: TriggerWatermark = { seenIds: wm.seenIds.slice(-500), lastPolledAt: wm.lastPolledAt };
  fs.writeFileSync(watermarkFile(specId), JSON.stringify(trimmed, null, 2) + '\n');
}
