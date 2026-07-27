/**
 * Harness 防循环熔断（H1）：
 * - repeatedCall：同 (tool+argsHash) 在滑窗内 ≥ 阈值 → 返回警告，供 brain 注入 system 提醒；
 * - stalled：外层迭代粒度，连续 N 轮无新工具签名 且 todo 无状态变化 → 熔断。
 */

const WINDOW = 12; // 工具调用滑窗
const REPEAT_THRESHOLD = 3; // 同签名达到此次数触发警告
const STALL_ITERATIONS = 2; // 连续无进展迭代数触发熔断

export class LoopGuard {
  private recent: string[] = []; // 最近调用签名滑窗
  private warned = new Set<string>(); // 已警告过的签名（再犯即熔断）
  private repeatEscalated = false;
  private iterSignatures: string[] = []; // 每轮迭代快照：工具签名集 + todo 签名
  private stallCount = 0;

  /** brain executeTool 处埋点 */
  record(toolName: string, argsHash: string): void {
    const sig = `${toolName}#${argsHash}`;
    this.recent.push(sig);
    if (this.recent.length > WINDOW) this.recent.shift();
  }

  /**
   * 检测滑窗内是否有签名达到重复阈值：
   * 首次命中返回警告文本；已警告过的签名再次命中 → 标记升级（stalled 将返回 true）。
   */
  repeatedCall(): string | null {
    const counts = new Map<string, number>();
    for (const s of this.recent) counts.set(s, (counts.get(s) ?? 0) + 1);
    for (const [sig, n] of counts) {
      if (n >= REPEAT_THRESHOLD) {
        if (this.warned.has(sig)) {
          this.repeatEscalated = true;
          return null; // 已警告过，不再重复提醒，交由 stalled 熔断
        }
        this.warned.add(sig);
        const tool = sig.split('#')[0];
        return `检测到你在滑窗内重复调用 ${tool}（参数相同）达 ${n} 次。请换一种策略，或明确说明为何需要重复；再次重复将终止本轮自主执行。`;
      }
    }
    return null;
  }

  /** 每轮外层迭代结束时快照当前工具签名集 + todo 签名 */
  snapshotIteration(todoSignature: string): void {
    const toolSig = [...new Set(this.recent)].sort().join(',');
    const combined = `${toolSig}||${todoSignature}`;
    const last = this.iterSignatures[this.iterSignatures.length - 1];
    if (last !== undefined && last === combined) {
      this.stallCount++;
    } else {
      this.stallCount = 0;
    }
    this.iterSignatures.push(combined);
  }

  /** 是否已停滞（连续无进展达阈值，或重复调用已升级） */
  stalled(): boolean {
    return this.repeatEscalated || this.stallCount >= STALL_ITERATIONS;
  }
}
