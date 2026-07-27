import fs from 'fs';
import path from 'path';
import { Capability, AgentTool, ToolResult } from '../types';
import { runCommand } from '../../exec';

/**
 * 本地环境管理能力模块：Node.js 版本检测/切换、包管理器检测、依赖安装。
 */

/** 执行命令并返回 stdout（静默失败） */
function exec(cmd: string, args: string[], cwd?: string): { ok: boolean; stdout: string } {
  try {
    const r = runCommand(cmd, args, { cwd });
    return { ok: r.ok, stdout: r.stdout.trim() };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/** 检测已安装的 Node 版本管理器 */
function detectNodeVersionManager(): 'fnm' | 'nvm' | null {
  if (exec('fnm', ['--version']).ok) return 'fnm';
  if (exec('bash', ['-c', 'source ~/.nvm/nvm.sh && nvm --version']).ok) return 'nvm';
  return null;
}

/** 读取项目期望的 Node 版本 */
function getExpectedNodeVersion(dir: string): string | null {
  // .nvmrc
  const nvmrc = path.join(dir, '.nvmrc');
  if (fs.existsSync(nvmrc)) return fs.readFileSync(nvmrc, 'utf8').trim();
  // .node-version
  const nodeVer = path.join(dir, '.node-version');
  if (fs.existsSync(nodeVer)) return fs.readFileSync(nodeVer, 'utf8').trim();
  // package.json engines.node
  const pkgPath = path.join(dir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.engines?.node) return pkg.engines.node;
    } catch { /* ignore */ }
  }
  return null;
}

/** 检测 lock 文件推断包管理器 */
function detectPackageManager(dir: string): 'yarn' | 'npm' | 'pnpm' | null {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return null;
}

const envCheck: AgentTool = {
  name: 'env_check',
  readOnly: true,
  description: '检测当前开发环境状态：Node.js 版本、npm/yarn/pnpm 版本、是否满足项目 .nvmrc 要求',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: '可选，项目目录（检测 .nvmrc 和 lock 文件）' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const lines: string[] = [];
    // Node
    const node = exec('node', ['--version']);
    lines.push(`Node.js: ${node.ok ? node.stdout : '未安装'}`);
    // npm
    const npm = exec('npm', ['--version']);
    lines.push(`npm: ${npm.ok ? npm.stdout : '未安装'}`);
    // yarn
    const yarn = exec('yarn', ['--version']);
    if (yarn.ok) lines.push(`yarn: ${yarn.stdout}`);
    // pnpm
    const pnpm = exec('pnpm', ['--version']);
    if (pnpm.ok) lines.push(`pnpm: ${pnpm.stdout}`);
    // 版本管理器
    const mgr = detectNodeVersionManager();
    lines.push(`版本管理器: ${mgr ?? '未检测到 (建议安装 fnm)'}`);
    // 项目要求
    const dir = args.projectDir ? String(args.projectDir) : process.cwd();
    const expected = getExpectedNodeVersion(dir);
    if (expected) {
      const current = node.ok ? node.stdout.replace(/^v/, '') : '';
      const match = current.startsWith(expected.replace(/^v/, '').replace(/[>=<^~ ]/g, ''));
      lines.push(`项目期望 Node: ${expected} ${match ? '✓ 满足' : '✗ 不满足'}`);
    }
    const pm = detectPackageManager(dir);
    if (pm) lines.push(`项目包管理器: ${pm}`);
    return { success: true, output: lines.join('\n') };
  },
};

/** 校验版本号格式（防止命令注入） */
function isValidVersion(v: string): boolean {
  return /^[a-zA-Z0-9._\-\/]+$/.test(v);
}

const envSwitchNode: AgentTool = {
  name: 'env_switch_node',
  description: '切换 Node.js 版本（通过 fnm 或 nvm）',
  parameters: {
    type: 'object',
    properties: {
      version: { type: 'string', description: 'Node.js 版本号（如 18, 20.11.0, lts）' },
    },
    required: ['version'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const mgr = detectNodeVersionManager();
    if (!mgr) {
      return { success: false, output: '未检测到 Node 版本管理器。请先安装 fnm (https://github.com/Schniz/fnm) 或 nvm。' };
    }
    const version = String(args.version);
    if (!isValidVersion(version)) {
      return { success: false, output: `版本号格式非法: ${version}（仅允许字母数字._-/）` };
    }
    if (mgr === 'fnm') {
      const r = exec('fnm', ['use', version]);
      return r.ok
        ? { success: true, output: `已通过 fnm 切换到 Node ${version}。` }
        : { success: false, output: `fnm use ${version} 失败。可能需要先安装：fnm install ${version}` };
    }
    // nvm 需要在 bash 子 shell 中
    const r = exec('bash', ['-c', `source ~/.nvm/nvm.sh && nvm use ${version}`]);
    return r.ok
      ? { success: true, output: `已通过 nvm 切换到 Node ${version}（仅影响当前 shell）。` }
      : { success: false, output: `nvm use ${version} 失败。可能需要先安装：nvm install ${version}` };
  },
};

const envInstallNode: AgentTool = {
  name: 'env_install_node',
  description: '安装指定版本的 Node.js（通过 fnm 或 nvm）',
  parameters: {
    type: 'object',
    properties: {
      version: { type: 'string', description: 'Node.js 版本号' },
    },
    required: ['version'],
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const mgr = detectNodeVersionManager();
    if (!mgr) {
      return { success: false, output: '未检测到 Node 版本管理器。请先安装 fnm 或 nvm。' };
    }
    const version = String(args.version);
    if (!isValidVersion(version)) {
      return { success: false, output: `版本号格式非法: ${version}（仅允许字母数字._-/）` };
    }
    if (mgr === 'fnm') {
      const r = exec('fnm', ['install', version]);
      return r.ok
        ? { success: true, output: `已通过 fnm 安装 Node ${version}。` }
        : { success: false, output: `fnm install ${version} 失败：${r.stdout}` };
    }
    const r = exec('bash', ['-c', `source ~/.nvm/nvm.sh && nvm install ${version}`]);
    return r.ok
      ? { success: true, output: `已通过 nvm 安装 Node ${version}。` }
      : { success: false, output: `nvm install ${version} 失败。` };
  },
};

const envDetectPm: AgentTool = {
  name: 'env_detect_pm',
  readOnly: true,
  description: '检测项目使用的包管理器（根据 lock 文件判断）',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: '项目目录，默认当前目录' },
    },
  },
  async execute(args): Promise<ToolResult> {
    const dir = args.projectDir ? String(args.projectDir) : process.cwd();
    const pm = detectPackageManager(dir);
    if (!pm) {
      return { success: true, output: `目录 ${dir} 下未检测到 lock 文件（yarn.lock / package-lock.json / pnpm-lock.yaml）。` };
    }
    return { success: true, output: `项目使用 ${pm}（检测到对应 lock 文件）。` };
  },
};

const envInstallDeps: AgentTool = {
  name: 'env_install_deps',
  description: '在目标目录执行依赖安装（自动检测包管理器或手动指定）',
  parameters: {
    type: 'object',
    properties: {
      projectDir: { type: 'string', description: '项目目录，默认当前目录' },
      pm: { type: 'string', enum: ['yarn', 'npm', 'pnpm'], description: '包管理器（省略则自动检测）' },
    },
  },
  needsConfirm: true,
  async execute(args): Promise<ToolResult> {
    const dir = args.projectDir ? String(args.projectDir) : process.cwd();
    const pm = args.pm ? String(args.pm) : (detectPackageManager(dir) ?? 'npm');
    const r = exec(pm, ['install'], dir);
    return r.ok
      ? { success: true, output: `已在 ${dir} 执行 ${pm} install 成功。` }
      : { success: false, output: `${pm} install 失败：${r.stdout.slice(-300)}` };
  },
};

export const envCapability: Capability = {
  name: 'env',
  description: '本地环境管理：Node.js 版本检测/切换/安装、包管理器检测、依赖安装',
  tools: [envCheck, envSwitchNode, envInstallNode, envDetectPm, envInstallDeps],
};
