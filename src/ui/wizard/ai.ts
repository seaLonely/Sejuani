import inquirer from 'inquirer';
import { chalk } from '../../utils/logger';
import { SejuaniConfig } from '../../config';
import { runAiFlow } from '../aiFlow';
import { listTemplates } from '../../core/workflow/templates';

/**
 * AI 工作流入口（向导）：可选「新建(AI 规划)」或「从模板套用」。
 * 两者均复用 runAiFlow（后者传入 template 选项，不调 AI，按当前选中组件重绑定）。
 */
export async function flowAi(config: SejuaniConfig): Promise<void> {
  const templates = listTemplates();
  const { mode } = await inquirer.prompt<{ mode: 'new' | 'template' }>([
    {
      type: 'list',
      name: 'mode',
      message: 'AI 工作流:',
      choices: [
        { name: '新建（选组件 + 自然语言描述，由 AI 规划）', value: 'new' },
        {
          name: `从模板套用${templates.length ? `（${templates.length} 个可用）` : '（暂无模板）'}`,
          value: 'template',
          disabled: templates.length === 0,
        },
      ],
    },
  ]);
  if (mode === 'template') {
    const { name } = await inquirer.prompt<{ name: string }>([
      {
        type: 'list',
        name: 'name',
        message: '选择模板:',
        choices: templates.map((t) => ({ name: `${t.name}  ${chalk.dim(`${t.title} · ${t.steps.length}步`)}`, value: t.name })),
      },
    ]);
    await runAiFlow(config, { template: name });
    return;
  }
  await runAiFlow(config, {});
}
