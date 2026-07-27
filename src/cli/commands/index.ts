import { Command } from 'commander';
import { register as registerWizard } from './wizard';
import { register as registerBatch } from './batch';
import { register as registerDeps } from './deps';
import { register as registerQuery } from './query';
import { register as registerVs } from './vs';
import { register as registerGuide } from './guide';
import { register as registerDomain } from './domain';
import { register as registerAlias } from './alias';
import { register as registerAi } from './ai';
import { register as registerFlow } from './flow';
import { register as registerYunxiaoConfig } from './yunxiaoConfig';
import { register as registerIssue } from './issue';
import { register as registerFix } from './fix';
import { register as registerTask } from './task';
import { register as registerAgent } from './agent';
import { register as registerServe } from './serve';

/** 依次注册所有命令组到 program。 */
export function registerAll(program: Command): void {
  registerWizard(program); // start（默认命令）
  registerBatch(program); // replace-url / set-version / set-name / link / sync / release / upgrade
  registerDeps(program); // registries / check-deps / deps-tree
  registerQuery(program); // catalog / who-uses / project-deps / usage
  registerVs(program); // vs
  registerGuide(program); // guide
  registerDomain(program); // domain / registry
  registerAlias(program); // alias
  registerAi(program); // ai / ai-config
  registerFlow(program); // flow / logs
  registerYunxiaoConfig(program); // yunxiao-config / yxcfg
  registerIssue(program); // issue list / issue view
  registerFix(program); // fix <issueId>
  registerTask(program); // task / task list / task do / task done
  registerAgent(program); // agent / chat
  registerServe(program); // serve（本地 HTTP API 服务）
}
