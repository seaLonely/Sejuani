/**
 * 手写 5 字段 cron 解析（分 时 日 月 周），支持 * 、/step 、a,b 、a-b 语法。
 * 零依赖；tick 精度为分钟级。周字段 0-7（0 与 7 均为周日）。
 */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
}

interface FieldRange {
  min: number;
  max: number;
}

const FIELDS: FieldRange[] = [
  { min: 0, max: 59 },  // 分
  { min: 0, max: 23 },  // 时
  { min: 1, max: 31 },  // 日
  { min: 1, max: 12 },  // 月
  { min: 0, max: 7 },   // 周（0/7=周日）
];

// 解析单个字段（如 "*"、"*/5"、"1,15"、"1-5"、"1-5/2"）为取值集合
function parseField(field: string, range: FieldRange, label: string): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [body, stepStr] = part.split('/');
    const step = stepStr !== undefined ? parseInt(stepStr, 10) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`cron ${label} 字段步进非法: ${part}`);
    }
    let lo: number;
    let hi: number;
    if (body === '*' || body === '') {
      lo = range.min;
      hi = range.max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-').map((s) => parseInt(s, 10));
      lo = a;
      hi = b;
    } else {
      lo = hi = parseInt(body, 10);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < range.min || hi > range.max || lo > hi) {
      throw new Error(`cron ${label} 字段取值非法: ${part}（允许 ${range.min}-${range.max}）`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

/** 解析 5 字段 cron 表达式；非法抛错（enable 时校验） */
export function parseCron(expr: string): CronSchedule {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须是 5 个字段（分 时 日 月 周）: "${expr}"`);
  }
  const labels = ['分', '时', '日', '月', '周'];
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i], labels[i]));
  // 周日归一：7 → 0
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return { minutes, hours, days, months, weekdays };
}

/** 判断给定时刻（本地时区，分钟精度）是否命中 */
export function cronMatches(s: CronSchedule, date: Date): boolean {
  return (
    s.minutes.has(date.getMinutes()) &&
    s.hours.has(date.getHours()) &&
    s.days.has(date.getDate()) &&
    s.months.has(date.getMonth() + 1) &&
    s.weekdays.has(date.getDay())
  );
}

/** 从 from 之后的下一次命中时刻（向后逐分钟扫描，上限 366 天）；无则 null */
export function nextCronTime(s: CronSchedule, from: Date): Date | null {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (cronMatches(s, cursor)) return new Date(cursor.getTime());
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
