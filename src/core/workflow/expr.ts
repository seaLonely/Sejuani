import { logEvent } from '../../utils/fileLogger';

/**
 * 受限数据流表达式（W2）：仅点路径取值 + 数组下标，不做任意 JS 求值。
 * 语法：{{steps.<id>.outputs.<key>}} / {{trigger.item.<field>}} / {{trigger.payload.<path>}}
 *       / {{env.domain}} / {{item.<field>}} / {{failure.reason}}
 * 未命中路径保留原文并 logEvent 警告（不中断执行）。
 */

export interface ExprContext {
  /** stepId -> outputs（= ctx.runOutputs） */
  steps: Record<string, Record<string, unknown>>;
  trigger?: { type: string; firedAt: string; item?: unknown; payload?: unknown };
  env: { domain: string };
  /** flow.foreach 迭代项 */
  item?: unknown;
  /** onFailure 步骤上下文 */
  failure?: { stepId: string; reason: string };
}

/** 把引擎的 runOutputs（stepId -> outputs 平铺）包装为表达式视图（steps.<id>.outputs.<key>） */
export function stepsView(runOutputs?: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [id, outputs] of Object.entries(runOutputs ?? {})) {
    out[id] = { outputs };
  }
  return out;
}

const EXPR_RE = /\{\{\s*([a-zA-Z_][\w.$[\]-]*)\s*\}\}/g;

/** 按点路径 + [n] 下标取值；根键限定为 ExprContext 的已知字段。未命中返回 undefined */
export function evalPath(path: string, ctx: ExprContext): unknown {
  // steps.<id>.outputs.<key> 的 <id> 可能含 - 等字符，统一按段切分
  const segments: Array<string | number> = [];
  for (const raw of path.split('.')) {
    // 支持 seg[0][1] 形式
    const m = raw.match(/^([^[\]]*)((\[\d+\])*)$/);
    if (!m) return undefined;
    if (m[1]) segments.push(m[1]);
    if (m[2]) {
      for (const idx of m[2].match(/\d+/g) ?? []) segments.push(parseInt(idx, 10));
    }
  }
  let cur: unknown = ctx as unknown;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

/** 表达式求值结果转为可插入文本 */
function toText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** 渲染单个模板字符串：替换全部 {{path}}；未命中路径保留原文并告警 */
export function renderTemplate(text: string, ctx: ExprContext): string {
  return text.replace(EXPR_RE, (raw, path: string) => {
    const value = evalPath(path, ctx);
    if (value === undefined) {
      logEvent('warn', 'expr.miss', { path });
      return raw; // 保留原文
    }
    return toText(value);
  });
}

/** 深度渲染 params：字符串字段做模板替换，数组/对象递归；返回渲染副本（不改原对象） */
export function renderParams<T>(value: T, ctx: ExprContext): T {
  if (typeof value === 'string') {
    return renderTemplate(value, ctx) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderParams(v, ctx)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderParams(v, ctx);
    }
    return out as unknown as T;
  }
  return value;
}

/** 求值 when 条件：路径取值为真值（非空数组/非空串/非0/true/对象）→ true */
export function evalWhen(expr: string, ctx: ExprContext): boolean {
  const trimmed = expr.trim().replace(/^\{\{\s*/, '').replace(/\s*\}\}$/, '');
  const value = evalPath(trimmed, ctx);
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
