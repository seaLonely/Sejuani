import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 极小 NDJSON 持久化日志（零第三方依赖，Node 20+）。
 *
 * 目标：终结 debug「盲盒」——把 AI 请求/响应原文、每步 start/end/结果、
 * 命令调用与错误落盘，便于事后追踪。
 *
 * - 每日文件： ~/.sejuani/logs/YYYY-MM-DD.log      （所有事件按天追加）
 * - 每次运行： ~/.sejuani/workflows/<runId>.run.log （单次工作流运行的完整流水）
 * - 每行一个 JSON： {ts, level, runId?, event, ...data}
 *
 * 设计约束：
 * - console 输出行为完全不变，本模块只做「额外」落盘。
 * - 任何写入失败都静默降级，绝不影响主流程（日志不该拖垮命令）。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOGS_DIR = path.join(os.homedir(), '.sejuani', 'logs');
const WORKFLOWS_DIR = path.join(os.homedir(), '.sejuani', 'workflows');

/** 当前活跃运行（由 startRunLog 设置，endRunLog 清除） */
let activeRunId: string | null = null;
let activeRunFile: string | null = null;

/** 当日日志文件路径（YYYY-MM-DD.log） */
function dailyFile(): string {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `${day}.log`);
}

/** 运行日志文件路径 */
function runFile(runId: string): string {
  return path.join(WORKFLOWS_DIR, `${runId}.run.log`);
}

/** 追加一行到文件；失败静默降级。 */
function appendLine(file: string, line: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line + '\n');
  } catch {
    /* 日志写入失败不影响主流程 */
  }
}

/**
 * 开启一次运行日志。后续 logEvent 会同时写入当日文件与该运行文件。
 * 返回运行日志文件路径（供 CLI 提示）。
 */
export function startRunLog(runId: string): string {
  activeRunId = runId;
  activeRunFile = runFile(runId);
  logEvent('info', 'run.start', { runId });
  return activeRunFile;
}

/** 结束当前运行日志。 */
export function endRunLog(summary?: Record<string, unknown>): void {
  logEvent('info', 'run.end', summary ?? {});
  activeRunId = null;
  activeRunFile = null;
}

/**
 * 记录一个结构化事件。写当日文件；若有活跃运行，另写该运行文件。
 * data 中的值会被安全序列化（循环引用/超大对象降级为字符串）。
 */
export function logEvent(level: LogLevel, event: string, data: Record<string, unknown> = {}): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  if (activeRunId) record.runId = activeRunId;
  for (const [k, v] of Object.entries(data)) record[k] = v;

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // 循环引用等：退化为可读字符串，保底不丢事件
    line = JSON.stringify({ ts: record.ts, level, event, note: 'unserializable data' });
  }

  appendLine(dailyFile(), line);
  if (activeRunFile) appendLine(activeRunFile, line);
}

/** 当前运行日志文件路径（无活跃运行返回 null） */
export function currentRunLogFile(): string | null {
  return activeRunFile;
}

/** 指定 runId 是否为当前活跃运行（供 engine 判断是否复用已开启的运行日志，避免重复 run.start）。 */
export function isRunLogActive(runId: string): boolean {
  return activeRunId === runId;
}

/** 指定运行的日志文件路径（用于 flow log <id>） */
export function runLogFile(runId: string): string {
  return runFile(runId);
}

/** 日志根目录（用于 sjn logs 提示） */
export function logsDir(): string {
  return LOGS_DIR;
}

/** 读取某运行日志的末尾若干行（用于 flow log <id> 快速查看）。 */
export function tailRunLog(runId: string, lines = 40): string[] {
  try {
    const file = runFile(runId);
    if (!fs.existsSync(file)) return [];
    const all = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
    return all.slice(-lines);
  } catch {
    return [];
  }
}
