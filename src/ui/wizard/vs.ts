import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { chalk, logger } from '../../utils/logger';
import { discoverComponents } from '../../core/discover';
import { createVirtualSpace } from '../../core/link';
import { inquirerConfirm } from '../prompt';
import { resolveScanTarget, SejuaniConfig } from '../../core/config';
import { flattenLayersJson } from '../../core/depsTree';
import {
  getVirtualSpaces,
  getVirtualSpace,
  saveVirtualSpace,
  removeVirtualSpace,
  resolveVsComponents,
  membersFromComponents,
  patchVirtualSpace,
  VsMember,
} from '../../core/state/virtualSpaces';
import { pickComponents } from './common';

/** 虚拟空间管理子流程：列表 / 详情 / 新建 / 物化软链 / 删除。 */

/** 从已有虚拟空间中挑一个（无则提示）。 */
async function pickVsName(message: string): Promise<string | null> {
  const spaces = getVirtualSpaces();
  const names = Object.keys(spaces).sort();
  if (names.length === 0) {
    logger.warn('暂无虚拟空间。可先用「依赖分层」保存，或在此新建。');
    return null;
  }
  const { picked } = await inquirer.prompt<{ picked: string }>([
    {
      type: 'list',
      name: 'picked',
      message,
      choices: names.map((n) => ({
        name: `${n}  ${chalk.dim(
          `${spaces[n].members.length} 个组件${spaces[n].layers ? ` · ${spaces[n].layers!.length} 层` : ''}`
        )}`,
        value: n,
      })),
    },
  ]);
  return picked;
}

/** 打印单个虚拟空间详情。 */
function showVsDetail(name: string): void {
  const vs = getVirtualSpace(name);
  if (!vs) {
    logger.error(`虚拟空间不存在: ${name}`);
    return;
  }
  logger.title(`虚拟空间 ${name}`);
  logger.info(chalk.dim(`来源: ${vs.source ?? '?'}   更新: ${vs.updatedAt}`));
  if (vs.linkedDir) logger.info(chalk.dim(`软链目录: ${vs.linkedDir}`));
  if (vs.layers && vs.layers.length > 0) {
    vs.layers.forEach((layer, i) => {
      logger.info(chalk.bold(`\nlayer-${i} ${chalk.dim(`(${layer.length})`)}`));
      for (const p of layer) logger.info(`  ${chalk.cyan(p)}`);
    });
  } else {
    for (const m of vs.members) logger.info(`  ${chalk.cyan(m.pkgName ?? m.name)}  ${chalk.dim(m.dir)}`);
  }
  logger.success(`\n共 ${vs.members.length} 个组件。`);
}

/** 新建虚拟空间：从组件库全量 / layers.json / 手动多选。 */
async function flowVsCreate(config: SejuaniConfig): Promise<void> {
  const { name } = await inquirer.prompt<{ name: string }>([
    { type: 'input', name: 'name', message: '新虚拟空间名称:', filter: (v: string) => v.trim() },
  ]);
  if (!name) {
    logger.warn('未输入名称，已取消。');
    return;
  }
  const { src } = await inquirer.prompt<{ src: 'catalog' | 'layers' | 'pick' }>([
    {
      type: 'list',
      name: 'src',
      message: '成员来源:',
      choices: [
        { name: '从当前域组件库全量', value: 'catalog' },
        { name: '从 deps-tree 导出的 layers.json', value: 'layers' },
        { name: '手动多选（从某范围挑选）', value: 'pick' },
      ],
    },
  ]);

  let members: VsMember[] = [];
  let layers: string[][] | undefined;
  let source = 'manual';
  if (src === 'catalog') {
    const t = resolveScanTarget(config.roots.components);
    logger.step(`扫描组件库 ${chalk.cyan(t.dir)} ...`);
    const comps = await discoverComponents(t.dir, { maxDepth: t.maxDepth });
    members = membersFromComponents(comps);
    source = `catalog:${config.activeDomain}`;
  } else if (src === 'layers') {
    const { file } = await inquirer.prompt<{ file: string }>([
      { type: 'input', name: 'file', message: 'layers.json 路径:', filter: (v: string) => v.trim() },
    ]);
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) {
      logger.error(`文件不存在: ${abs}`);
      return;
    }
    const flat = flattenLayersJson(JSON.parse(fs.readFileSync(abs, 'utf8')));
    members = flat.members.map((m) => ({ name: path.basename(m.dir), pkgName: m.name, dir: m.dir }));
    layers = flat.layers;
    source = `layers:${abs}`;
  } else {
    const comps = await pickComponents(config);
    members = membersFromComponents(comps);
    source = 'manual';
  }
  if (members.length === 0) {
    logger.warn('没有可加入的成员，未创建。');
    return;
  }
  const vs = saveVirtualSpace(name, { members, layers, source });
  logger.success(
    `已创建虚拟空间 ${chalk.bold(name)}（${vs.members.length} 个组件${layers ? `，${layers.length} 层` : ''}）`
  );
  logger.info(chalk.dim(`使用: sjn <命令> --vs ${name}`));
}

/** 把虚拟空间物化成软链目录。 */
async function flowVsLink(): Promise<void> {
  const name = await pickVsName('选择要物化(软链)的虚拟空间:');
  if (!name) return;
  const resolved = resolveVsComponents(name);
  if (!resolved) {
    logger.error(`虚拟空间不存在: ${name}`);
    return;
  }
  if (resolved.missing.length > 0) {
    logger.warn(`有 ${resolved.missing.length} 个成员目录已失效，已跳过: ${resolved.missing.join(', ')}`);
  }
  const { into, force, dryRun } = await inquirer.prompt<{ into: string; force: boolean; dryRun: boolean }>([
    {
      type: 'input',
      name: 'into',
      message: '软链目标目录:',
      default: path.join(process.cwd(), name),
      filter: (v: string) => v.trim(),
    },
    { type: 'confirm', name: 'force', message: '覆盖已存在的同名软链?', default: false },
    { type: 'confirm', name: 'dryRun', message: '先干跑预览(不创建)?', default: true },
  ]);
  await createVirtualSpace(resolved.components, { into: path.resolve(into), force, dryRun, yes: false, confirm: inquirerConfirm });
  if (!dryRun) patchVirtualSpace(name, { linkedDir: path.resolve(into) });
}

/** 虚拟空间管理：列表 / 详情 / 新建 / 物化软链 / 删除。 */
export async function flowVs(config: SejuaniConfig): Promise<void> {
  const { op } = await inquirer.prompt<{ op: 'list' | 'show' | 'create' | 'link' | 'rm' | 'back' }>([
    {
      type: 'list',
      name: 'op',
      message: '虚拟空间管理:',
      choices: [
        { name: '查看列表', value: 'list' },
        { name: '查看详情', value: 'show' },
        { name: '新建虚拟空间', value: 'create' },
        { name: '物化为软链目录 (link)', value: 'link' },
        { name: '删除', value: 'rm' },
        new inquirer.Separator(),
        { name: '↩ 返回', value: 'back' },
      ],
    },
  ]);
  if (op === 'back') return;
  if (op === 'create') {
    await flowVsCreate(config);
    return;
  }
  if (op === 'link') {
    await flowVsLink();
    return;
  }
  if (op === 'list') {
    const spaces = getVirtualSpaces();
    const names = Object.keys(spaces).sort();
    logger.title('虚拟空间 (vs)');
    if (names.length === 0) {
      logger.info(chalk.dim('  (暂无) 用「依赖分层」保存，或此处新建'));
    } else {
      for (const n of names) {
        const vs = spaces[n];
        const layerNote = vs.layers ? ` · ${vs.layers.length} 层` : '';
        const linkNote = vs.linkedDir ? ` · 软链→${vs.linkedDir}` : '';
        logger.info(`  ${chalk.bold(n)}  ${chalk.dim(`${vs.members.length} 个组件${layerNote}${linkNote}`)}`);
      }
    }
    return;
  }
  if (op === 'show') {
    const name = await pickVsName('选择要查看的虚拟空间:');
    if (name) showVsDetail(name);
    return;
  }
  if (op === 'rm') {
    const name = await pickVsName('选择要删除的虚拟空间:');
    if (!name) return;
    const { ok } = await inquirer.prompt<{ ok: boolean }>([
      { type: 'confirm', name: 'ok', message: `确认删除虚拟空间 ${name}?`, default: false },
    ]);
    if (!ok) return;
    if (removeVirtualSpace(name)) logger.success(`已删除虚拟空间 ${chalk.bold(name)}`);
    else logger.warn(`虚拟空间不存在: ${name}`);
    return;
  }
}
