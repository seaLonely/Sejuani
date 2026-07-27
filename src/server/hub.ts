import { ServerResponse } from 'http';
import { sseOpen, sseSend } from './http';

/**
 * 事件中心：命名频道的 SSE 订阅/发布 + 确认桥。
 * Agent 会话（agent:<sessionId>）与工作流运行（workflow:<id>）共用：
 * print/进度事件经频道推送；confirm 回调挂起 Promise，由 HTTP 确认接口唤醒。
 */

/** 确认请求默认超时（10 分钟），超时按「取消」处理，避免永久挂起占住运行锁 */
const CONFIRM_TIMEOUT_MS = 10 * 60 * 1000;

export class EventHub {
  private channels = new Map<string, Set<ServerResponse>>();
  private pending = new Map<string, (answer: 'yes' | 'no' | 'always') => void>();
  private pendingInputs = new Map<string, (value: string) => void>();
  private seq = 0;

  /** 订阅频道（接管 res，按 SSE 协议持续写入，连接关闭时自动退订） */
  subscribe(channel: string, res: ServerResponse): void {
    sseOpen(res);
    let set = this.channels.get(channel);
    if (!set) {
      set = new Set();
      this.channels.set(channel, set);
    }
    set.add(res);
    res.on('close', () => {
      set.delete(res);
      if (set.size === 0) this.channels.delete(channel);
    });
  }

  /** 向频道全部订阅者推送事件；返回送达的订阅者数量 */
  publish(channel: string, event: string, data: unknown): number {
    const set = this.channels.get(channel);
    if (!set) return 0;
    for (const res of set) {
      try {
        sseSend(res, event, data);
      } catch {
        /* 写入失败（连接半开）忽略，close 时会清理 */
      }
    }
    return set.size;
  }

  /**
   * 发起一次确认：向频道推送 confirm 事件 { id, message } 并挂起，
   * 等待 answer() 唤醒；超时未应答按 false（取消）处理。
   */
  ask(channel: string, message: string): Promise<boolean> {
    return this.askEx(channel, message).then((a) => a === 'yes' || a === 'always');
  }

  /**
   * 三态确认：同 ask，但保留 always（总是允许）应答，供 Agent 会话级授权用。
   * 超时未应答按 'no' 处理。
   */
  askEx(channel: string, message: string): Promise<'yes' | 'no' | 'always'> {
    const id = `c${Date.now().toString(36)}_${++this.seq}`;
    this.publish(channel, 'confirm', { id, message });
    return new Promise<'yes' | 'no' | 'always'>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.publish(channel, 'confirm-timeout', { id });
          resolve('no');
        }
      }, CONFIRM_TIMEOUT_MS);
      this.pending.set(id, (answer) => {
        clearTimeout(timer);
        resolve(answer);
      });
    });
  }

  /** 唤醒挂起的确认；id 不存在（或已超时）返回 false */
  answer(id: string, ok: boolean, always = false): boolean {
    const resolve = this.pending.get(id);
    if (!resolve) return false;
    this.pending.delete(id);
    resolve(ok ? (always ? 'always' : 'yes') : 'no');
    return true;
  }

  /**
   * 发起一次文本输入请求：向频道推送 input-request 事件 { id, message } 并挂起，
   * 等待 answerInput() 唤醒；超时未应答按空串（无法补全）处理。
   */
  askInput(channel: string, message: string): Promise<string> {
    const id = `i${Date.now().toString(36)}_${++this.seq}`;
    this.publish(channel, 'input-request', { id, message });
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingInputs.delete(id)) {
          this.publish(channel, 'input-timeout', { id });
          resolve('');
        }
      }, CONFIRM_TIMEOUT_MS);
      this.pendingInputs.set(id, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  /** 唤醒挂起的输入请求；id 不存在（或已超时）返回 false */
  answerInput(id: string, value: string): boolean {
    const resolve = this.pendingInputs.get(id);
    if (!resolve) return false;
    this.pendingInputs.delete(id);
    resolve(value);
    return true;
  }
}
