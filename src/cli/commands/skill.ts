import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';
import { inquirerConfirm, inquirerInput } from '../../ui/prompt';
import { loadConfig } from '../../core/config';
import { listSkills, loadSkill, removeSkill, skillsDir, saveSkill } from '../../core/skill/store';
import { runSkill } from '../../core/skill/run';
import { readSkillMdFrom, toSkillMd } from '../../core/skill/portable';
import fs from 'fs';
import path from 'path';

/** sjn skill：管理与执行技能。list | show <name> | run <name> | rm <name> */
export function register(program: Command): void {
  program
    .command('skill [action] [name] [dir]')
    .description('技能管理：skill list | show <name> | run <name> | rm <name> | import <path> | export <name> [dir]')
    .option('-c, --config <file>', '指定配置文件')
    .option('-y, --yes', 'run：跳过确认', false)
    .action(async (action: string | undefined, name: string | undefined, dir: string | undefined, opts) => {
      const act = (action ?? 'list').toLowerCase();

      if (act === 'list') {
        const skills = listSkills();
        logger.title(`技能（${skills.length}）`);
        if (skills.length === 0) {
          logger.info(chalk.dim(`  暂无。用 Agent 的 skill_save 或 sjn flow save-skill 固化。目录: ${skillsDir()}`));
          return;
        }
        for (const s of skills) {
          logger.info(`  ${chalk.bold(s.name)} ${chalk.dim(`(${s.kind})`)} ${s.title}  ${chalk.dim(s.description)}`);
        }
        logger.info(chalk.dim(`\n目录: ${skillsDir()}`));
        return;
      }

      if (!name) {
        logger.error(`操作 ${act} 需要技能名。例如: sjn skill ${act} <name>`);
        process.exitCode = 1;
        return;
      }

      if (act === 'show') {
        const s = loadSkill(name);
        if (!s) { logger.error(`技能不存在: ${name}`); process.exitCode = 1; return; }
        logger.title(`技能 ${s.name}：${s.title}`);
        logger.info(chalk.dim(`kind: ${s.kind}  ${s.description}`));
        if (s.triggers?.length) logger.info(chalk.dim(`触发词: ${s.triggers.join(', ')}`));
        if (s.kind === 'workflow') {
          (s.steps ?? []).forEach((st, i) => logger.info(`  ${i + 1}. ${st.title} ${chalk.dim(`(${st.kind})`)}${st.dangerous ? chalk.yellow(' [不可逆]') : ''}`));
        } else {
          logger.info('\n' + (s.guide ?? ''));
        }
        return;
      }

      if (act === 'run') {
        const s = loadSkill(name);
        if (!s) { logger.error(`技能不存在: ${name}`); process.exitCode = 1; return; }
        const config = loadConfig(opts.config);
        const r = await runSkill(config, s, { yes: !!opts.yes, confirm: inquirerConfirm, promptInput: inquirerInput });
        if (r.ok) logger.success(r.summary); else { logger.warn(r.summary); process.exitCode = 1; }
        return;
      }

      if (act === 'rm' || act === 'remove') {
        if (removeSkill(name)) logger.success(`已删除技能 ${chalk.bold(name)}`);
        else logger.warn(`技能不存在: ${name}`);
        return;
      }

      if (act === 'import') {
        // name 位置为源路径（SKILL.md 文件或含 SKILL.md 的目录）
        try {
          const skill = readSkillMdFrom(name);
          const dir = saveSkill(skill);
          logger.success(`已导入技能 ${chalk.bold(skill.name)}（prompt 型）→ ${dir}`);
        } catch (err) {
          logger.error((err as Error).message);
          process.exitCode = 1;
        }
        return;
      }

      if (act === 'export') {
        const s = loadSkill(name);
        if (!s) { logger.error(`技能不存在: ${name}`); process.exitCode = 1; return; }
        const outDir = dir || process.cwd(); // dir = 目标目录（缺省 cwd）
        const outFile = path.join(outDir, `${s.name}.SKILL.md`);
        fs.writeFileSync(outFile, toSkillMd(s));
        logger.success(`已导出标准 SKILL.md → ${outFile}`);
        return;
      }

      logger.error(`未知操作: ${action}。可用: list / show <name> / run <name> / rm <name> / import <path> / export <name> [dir]`);
      process.exitCode = 1;
    });
}
