import inquirer from 'inquirer';
import { ConfirmFn, PromptInputFn } from '../core/types';
import { ConfirmAnswer } from '../core/agent/types';

/**
 * 终端交互回调的 inquirer 实现：注入给 core（runner / repoSync / link / workflow engine）。
 * core 本身不依赖 inquirer，交互能力全部由展示层（CLI/向导）或服务端确认桥提供。
 */

/** inquirer 版确认回调（default=false，与历史行为一致）。 */
export const inquirerConfirm: ConfirmFn = async (message) => {
  const { ok } = await inquirer.prompt<{ ok: boolean }>([
    { type: 'confirm', name: 'ok', message, default: false },
  ]);
  return ok;
};

/** inquirer 版输入回调（trim 后返回）。 */
export const inquirerInput: PromptInputFn = async (message) => {
  const { val } = await inquirer.prompt<{ val: string }>([
    { type: 'input', name: 'val', message, filter: (v: string) => v.trim() },
  ]);
  return val;
};

/** inquirer 版三态确认：是 / 否 / 本会话内总是允许（Agent 会话级授权用）。 */
export const inquirerConfirmEx = async (message: string): Promise<ConfirmAnswer> => {
  const { answer } = await inquirer.prompt<{ answer: ConfirmAnswer }>([
    {
      type: 'list',
      name: 'answer',
      message,
      default: 'no',
      choices: [
        { name: '是，执行本次', value: 'yes' },
        { name: '否，取消', value: 'no' },
        { name: '总是允许（本会话内同名工具不再询问）', value: 'always' },
      ],
    },
  ]);
  return answer;
};
