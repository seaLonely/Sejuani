import { readState, writeState } from './stateFile';

/**
 * 当前域的持久化：写入用户级 ~/.sejuani/state.json，跨会话生效。
 * 与 sejuani.config.json 解耦，避免把「临时切换的域」写进项目配置。
 */

/** 读取持久化的当前域；未设置返回 undefined */
export function getActiveDomainOverride(): string | undefined {
  const v = readState().activeDomain;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 持久化当前域 */
export function setActiveDomain(domain: string): void {
  const state = readState();
  state.activeDomain = domain;
  writeState(state);
}
