import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { chalk, logger } from '../../utils/logger';
import { SejuaniConfig } from '../../config';
import { promptRoot } from '../select';
import { printRegistries } from '../../core/registries';
import { checkDependencies } from '../../core/depCheck';
import { analyzeLayers, printLayers, toLayersJson } from '../../core/depsTree';
import { saveVirtualSpace, VsMember } from '../../core/vsStore';
import { componentsFromTarget } from './common';

export async function flowRegistries(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  if (!target) return;
  const comps = await componentsFromTarget(target, { requireYarnLock: true });
  const { byComponent } = await inquirer.prompt<{ byComponent: boolean }>([
    { type: 'confirm', name: 'byComponent', message: '展开每个仓库涉及的组件?', default: false },
  ]);
  printRegistries(comps, byComponent);
}

export async function flowCheckDeps(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config);
  if (!target) return;
  const comps = await componentsFromTarget(target, { requireYarnLock: true });
  const { concurrency, timeout, onlyMissing } = await inquirer.prompt<{
    concurrency: number;
    timeout: number;
    onlyMissing: boolean;
  }>([
    { type: 'number', name: 'concurrency', message: '并发数:', default: 12 },
    { type: 'number', name: 'timeout', message: '单请求超时(ms):', default: 8000 },
    { type: 'confirm', name: 'onlyMissing', message: '只显示异常项?', default: true },
  ]);
  await checkDependencies(comps, { concurrency, timeout, onlyMissing });
}

/** 依赖分层：分析组件间依赖 → 打印 layer-0→x，可导出 JSON / 存为虚拟空间 */
export async function flowDepsTree(config: SejuaniConfig): Promise<void> {
  const target = await promptRoot(config, '选择要分析的组件库范围:');
  if (!target) return;
  const comps = await componentsFromTarget(target);
  if (comps.length === 0) {
    logger.warn('未发现可分析的组件。');
    return;
  }
  const root = target.components ? target.label ?? target.dir : target.dir;
  const result = analyzeLayers(comps, root);
  printLayers(result);

  const { save } = await inquirer.prompt<{ save: ('json' | 'vs')[] }>([
    {
      type: 'checkbox',
      name: 'save',
      message: '导出结果?（空格选，回车确认；不选则跳过）',
      choices: [
        { name: '导出分层 JSON 文件', value: 'json' },
        { name: '保存为虚拟空间（可用 --vs 引用）', value: 'vs' },
      ],
    },
  ]);

  if (save.includes('json')) {
    const { file } = await inquirer.prompt<{ file: string }>([
      {
        type: 'input',
        name: 'file',
        message: 'JSON 输出路径:',
        default: path.join(process.cwd(), 'layers.json'),
        filter: (v: string) => v.trim(),
      },
    ]);
    fs.writeFileSync(path.resolve(file), JSON.stringify(toLayersJson(result), null, 2) + '\n');
    logger.success(`已导出分层 JSON: ${path.resolve(file)}`);
  }

  if (save.includes('vs')) {
    const { vsName } = await inquirer.prompt<{ vsName: string }>([
      { type: 'input', name: 'vsName', message: '虚拟空间名称:', filter: (v: string) => v.trim() },
    ]);
    if (!vsName) {
      logger.warn('未输入名称，已跳过保存。');
      return;
    }
    const members: VsMember[] = [];
    const layers: string[][] = result.layers.map((l) => l.map((c) => c.name));
    for (const layer of result.layers) {
      for (const c of layer) members.push({ name: path.basename(c.dir), pkgName: c.name, dir: c.dir });
    }
    for (const c of result.cycles) members.push({ name: path.basename(c.dir), pkgName: c.name, dir: c.dir });
    saveVirtualSpace(vsName, { members, layers, source: `deps-tree:${root}` });
    logger.success(`已保存为虚拟空间 ${chalk.bold(vsName)}（${members.length} 个组件，${layers.length} 层）`);
    logger.info(chalk.dim(`使用: sjn <命令> --vs ${vsName}`));
  }
}
