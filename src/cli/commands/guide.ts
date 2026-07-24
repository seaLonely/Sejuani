import { Command } from 'commander';
import { chalk, logger } from '../../utils/logger';

function printGuide(): void {
  const g = `
${chalk.bold.cyan('Sejuani (sjn) · 使用手册')}
批量管理前端工程 / 组件的 package.json、yarn.lock，并提供仓同步与依赖治理。

${chalk.bold('■ 配置标准（替代 rh.toml）')}
  就近查找 sejuani.config.json（cwd 向上），或用 --config <file> 指定；无则用内置默认。
  结构:
    {
      "registries": { "pack": "<拉取源>", "publish": "<发布目标>" },
      "roots": {
        "projects":   { "root": "<工程根>",   "packagesDir": "workspace", "depth": 1 },
        "components": { "root": "<组件库根>", "packagesDir": "workspace", "depth": 1 }
      }
    }
  约定：若 <root>/<packagesDir> 存在则扫描它并用 depth，否则直接扫描 <root>。

${chalk.bold('■ 预设路径 / 目录覆盖')}
  各命令支持 --config、--dir、--projects <dir>、--components <dir>；未指定则回退配置/内置默认。
  交互式向导可在「工程 / 组件库 / 手动输入」间选择扫描范围。

${chalk.bold('■ 安全模式')}
  所有写操作（replace-url / set-version / set-name / upgrade）走「预览 → 确认 → .bak 备份 → 写入」。
  --dry-run 仅预览；-y 跳过确认；--no-backup 不备份；--diff 显示逐行 diff。

${chalk.bold('■ 批量编辑命令')}
  replace-url  批量替换 yarn.lock 中 resolved 的 URL 片段（-f/--from, -t/--to）
  set-version  批量改 package.json version（-b bump 或 -t 指定值，保留 -后缀）
  set-name     批量改 package.json name（--find/--replace 或 -t 固定值）
  link         把选定组件以软链聚合到虚拟空间（-i/--into）
  sync         仓同步：npm pack → npm publish → 清理 tgz（--pack-registry/--publish-registry）
  upgrade      按组件库 catalog 精确版本升级工程内组件依赖（不改 yarn.lock）

${chalk.bold('■ 依赖治理 / 查询命令（只读）')}
  registries          枚举 yarn.lock 中的所有仓库（--by-component 展开组件）
  check-deps          校验依赖 URL 是否可访问（--concurrency/--timeout/--only-missing）
  catalog             列出组件库下每个组件名称+版本（--json [file] 打印或导出文件；--vs 限定集合）
  who-uses <组件>     查询某组件被哪些工程使用
  project-deps <工程> 查询某工程用了哪些组件（含可升级标记）
  usage               全工程组件用量统计 + 未使用组件清单（--json）
  deps-tree [dir]     分析组件间依赖并拓扑分层（layer-0→x）
                      --json [file] 导出按层 JSON；--save <名> 存为虚拟空间；--vs <名> 只分析该集合

${chalk.bold('■ 虚拟空间(vs) — 命名组件集合')}
  虚拟空间是一个命名的组件集合（持久化到 ~/.sejuani/state.json），
  可替代“写死的域组件仓”作为操作目标：任何组件命令加 --vs <名> 即可。
  vs                        查看全部虚拟空间
  vs show <名>             查看详情（含分层）
  vs create <名>           新建：--from-layers <file>[--layers 0,1] / --from-catalog / 交互多选
  vs rm <名>               删除
  vs link <名> --into <dir> 把成员物化为软链目录（等价 link --vs）
  示例: sjn deps-tree --save core  →  sjn set-version --vs core -b patch  →  sjn vs link core --into ./.space

${chalk.bold('■ 常见组合')}
  1) 查看组件库有哪些组件及版本:        sjn catalog
  2) 看某组件谁在用:                    sjn who-uses @f6p/xxx
  3) 升级所有工程组件到最新精确版本:    sjn upgrade --dry-run --diff  →  sjn upgrade -y
  4) 换源前先排查仓库与可用性:          sjn registries && sjn check-deps --only-missing
  5) 组件发布到 nexus:                  sjn sync --dry-run  →  sjn sync -y

${chalk.bold('■ AI 工作流(ai/flow) — 自然语言驱动的可审阅编排')}
  选组件 + 用一句话描述意图 → AI 生成结构化工作流 → 终端审阅 → 确认后按依赖顺序确定性执行。
  规划前会先用确定性影响域引擎算出「受影响工程 + 上游波及组件 + 建议发布层序」并展示（范围不由 AI 臆造）。
  覆盖：组件升级/发包/同步、使用方工程升级/装依赖/分支拉取合并；不可逆步骤(发布/合并/push)在确认时高亮。
  ai-config show|set-key <k>|set-base <url>|set-model <m>   配置 AI 接入（兼容 OpenAI，可环境变量 OPENAI_API_KEY）
  ai [描述...]        选组件→描述→生成并审阅工作流（--dry-run 仅预览，-y 跳过确认）
  ai ... --save-template <名>   把本次生成的工作流存为模板
  ai --template <名>            纯套用模板（不调 AI），按当前选中组件重绑定
  flow list|show <id>|run <id>|resume <id>                 管理/续跑已保存的工作流
  flow template [list|show <名>|rm <名>]                    管理工作流模板
  flow log <id>                                            查看某次运行的 NDJSON 日志（含 AI 请求/响应原文）
  logs                                                     打印日志目录位置

${chalk.dim('提示：升级后需在各工程重新执行 yarn install 以同步 yarn.lock。')}
`;
  logger.info(g);
}

/** Feature F - guide 中文手册命令。 */
export function register(program: Command): void {
  program
    .command('guide')
    .description('打印完整中文使用手册')
    .action(() => {
      printGuide();
    });
}
