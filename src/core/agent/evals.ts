import fs from 'fs';
import { SejuaniConfig } from '../config';
import { AgentHarness, HarnessOutcome, VerifySpec } from './harness';

/**
 * Evals 基准任务集（R5）：录制一组标准目标，回放跑 Harness 并汇总终局，
 * 用于改 prompt/模型后量化对比。零依赖；真实回放需配置 AI key。
 */

export interface EvalCase {
  name: string;
  goal: string;
  /** 期望终局（缺省 completed） */
  expect?: HarnessOutcome;
  /** 可选验证命令（跑完 goal 后执行，作为通过判据） */
  verify?: VerifySpec;
  /** 单例预算：工具调用 / 墙钟 */
  maxToolCalls?: number;
  maxWallClockMs?: number;
}

export interface EvalResult {
  name: string;
  goal: string;
  outcome: HarnessOutcome;
  expected: HarnessOutcome;
  pass: boolean;
  iterations: number;
  toolCalls: number;
  totalTokens: number;
}

export interface EvalReport {
  total: number;
  passed: number;
  results: EvalResult[];
}

/** 内置基准集（可被 --file 覆盖） */
export const BUILTIN_CASES: EvalCase[] = [
  { name: 'list-components', goal: '列出当前组件库 catalog 中的组件数量并简述分层情况。', expect: 'completed', maxToolCalls: 8 },
  { name: 'env-check', goal: '检测当前开发环境的 Node/npm 版本是否满足项目要求。', expect: 'completed', maxToolCalls: 5 },
];

/** 从 JSON 文件加载用例集 */
export function loadCases(file: string): EvalCase[] {
  const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(arr)) throw new Error('用例文件应为 EvalCase 数组');
  return arr as EvalCase[];
}

/**
 * 回放执行一组用例，返回汇总报告。
 * 每个用例独立 Harness（无 sessionId，不污染真实会话）。
 */
export async function runEvals(
  config: SejuaniConfig,
  cases: EvalCase[],
  onProgress?: (name: string, outcome: HarnessOutcome) => void
): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    const expected = c.expect ?? 'completed';
    const harness = new AgentHarness(config, {
      budget: { maxToolCalls: c.maxToolCalls, maxWallClockMs: c.maxWallClockMs },
      verify: c.verify,
      maxIterations: 6,
    });
    let outcome: HarnessOutcome = 'stalled';
    let iterations = 0;
    let toolCalls = 0;
    let totalTokens = 0;
    try {
      const r = await harness.runGoal(c.goal);
      outcome = r.outcome;
      iterations = r.iterations;
      toolCalls = r.usage.toolCalls;
      totalTokens = r.usage.promptTokens + r.usage.completionTokens;
    } catch {
      outcome = 'stalled';
    }
    onProgress?.(c.name, outcome);
    results.push({ name: c.name, goal: c.goal, outcome, expected, pass: outcome === expected, iterations, toolCalls, totalTokens });
  }
  return { total: results.length, passed: results.filter((r) => r.pass).length, results };
}
