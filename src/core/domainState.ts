import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * 当前域的持久化：写入用户级 ~/.sejuani/state.json，跨会话生效。
 * 与 sejuani.config.json 解耦，避免把「临时切换的域」写进项目配置。
 */
const STATE_DIR = path.join(os.homedir(), '.sejuani');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

interface SejuaniState {
  activeDomain?: string;
}

function readState(): SejuaniState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SejuaniState;
  } catch {
    return {};
  }
}

/** 读取持久化的当前域；未设置返回 undefined */
export function getActiveDomainOverride(): string | undefined {
  const v = readState().activeDomain;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** 持久化当前域 */
export function setActiveDomain(domain: string): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const state = readState();
  state.activeDomain = domain;
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

/** 状态文件路径（用于提示） */
export function stateFilePath(): string {
  return STATE_FILE;
}
