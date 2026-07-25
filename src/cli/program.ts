import { Command } from 'commander';
import { chalk } from '../utils/logger';
import { readPkgVersion } from './context';

/**
 * 创建并配置顶层 Command：设置 name/description/version 与帮助文案。
 * 命令注册由 cli/commands/index.ts 的 registerAll 完成。
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('sejuani')
    .description(
      '批量管理前端工程 / 组件（projects & components）的 package.json / yarn.lock、仓同步与依赖治理的终端工具 (别名: sjn)'
    )
    .version(readPkgVersion());

  // Feature F - 顶层帮助：前置 banner + 后置分组总览/全局选项/示例
  program.addHelpText(
    'beforeAll',
    `
${chalk.bold.cyan('Sejuani')} ${chalk.dim('(sjn)')} · 前端工程 / 组件批量与依赖治理终端工具
${chalk.dim('扫描工程(projects)与组件库(components)，批量编辑 package.json / yarn.lock，并提供仓同步与依赖治理。')}
`
  );

  program.addHelpText(
    'after',
    `
${chalk.bold('命令分类:')}
  ${chalk.bold('交互式')}    start(默认) [-a|-w]              启动向导；默认直进批量编辑，-a 看全部分类，-w 直进任务看板
  ${chalk.bold('任务管理')}  task [list|view|do|done]           任务看板 / 工单查询 / 快速流转
  ${chalk.bold('批量编辑')}  replace-url / set-version /       写操作，均走预览→确认→.bak备份→写入
              set-name / upgrade / link / sync
  ${chalk.bold('依赖治理')}  registries / check-deps /         只读，枚举仓库 / 校验依赖 / 依赖分层
              deps-tree
  ${chalk.bold('查询统计')}  catalog / who-uses /              只读，组件清单 / 反查 / 用量统计
              project-deps / usage
  ${chalk.bold('虚拟空间')}  vs [list|show|create|rm|link]     命名组件集合，可用 --vs 引用 / 物化软链
  ${chalk.bold('智能Agent')} agent (chat)                     对话式开发助手（自然语言→全自动执行）
  ${chalk.bold('帮助')}      guide                             打印完整中文手册
  ${chalk.bold('域设置')}  domain [name]                     查看/切换域 chery·foton·saas

${chalk.bold('通用选项:')}
  -c, --config <file>   指定 sejuani.config.json（默认就近向上查找，无则用内置默认）
  -d, --dir <dir>       直接指定扫描目录（优先级最高）
  --projects <dir>      工程根目录（覆盖配置）
  --components <dir>    组件库根目录（覆盖配置）
  ${chalk.dim('扫描目标优先级：--dir > --projects > --components > 配置/内置默认。')}

${chalk.bold('写操作安全选项（replace-url / set-version / set-name / upgrade）:')}
  --dry-run   仅预览不写入      -y, --yes   跳过确认
  --no-backup 不生成 .bak 备份   --diff      展示逐行 diff

${chalk.bold('典型示例:')}
  ${chalk.dim('# 交互式向导（推荐）')}
  $ sjn                                    # 默认直进「批量编辑」
  $ sjn -a                                 # 展示全部功能分类
  $ sjn -w                                 # 直进「任务看板」

  ${chalk.dim('# 任务管理（云效工单）')}
  $ sjn task                                # 交互式任务看板
  $ sjn task list                           # 非交互式列表
  $ sjn task do <id>                        # 快速流转到「开发中」
  $ sjn task done <id>                      # 快速流转到「待测试」

  ${chalk.dim('# 组件库清单 / 用量统计 / 反查')}
  $ sjn catalog
  $ sjn catalog --json catalog.json        # 导出所有组件名称+版本到文件
  $ sjn usage
  $ sjn who-uses @f6p/account-book-shop
  $ sjn project-deps my-app

  ${chalk.dim('# 升级工程内组件到 catalog 精确版本（先干跑）')}
  $ sjn upgrade --dry-run --diff
  $ sjn upgrade -y

  ${chalk.dim('# 依赖治理')}
  $ sjn registries --by-component
  $ sjn check-deps --only-missing

  ${chalk.dim('# 依赖分层 + 虚拟空间')}
  $ sjn deps-tree                          # 打印 layer-0→x
  $ sjn deps-tree --json layers.json       # 导出按层划分的 JSON
  $ sjn deps-tree --save core              # 分析并存为虚拟空间 core
  $ sjn vs                                 # 查看虚拟空间列表
  $ sjn vs create core --from-layers layers.json --layers 0,1
  $ sjn set-version --vs core -b patch     # 对虚拟空间批量操作
  $ sjn vs link core --into ./.space       # 物化为软链目录

  ${chalk.dim('# 仓同步（先干跑查看命令）')}
  $ sjn sync --dry-run

  ${chalk.dim('# 指定配置 / 临时换扫描路径')}
  $ sjn usage -c ./sejuani.config.json
  $ sjn catalog --components /path/to/lib-workspace

  ${chalk.dim('# 完整手册')}
  $ sjn guide

${chalk.bold('域(domain):')}
  chery(奇瑞) / foton(福田) / saas 各对应不同的工程仓库与组件仓库。
  ${chalk.dim('sjn domain            # 查看当前域与列表')}
  ${chalk.dim('sjn domain foton      # 切换到福田域（持久化到 ~/.sejuani/state.json）')}

${chalk.bold('registry 地址（release·sync 的 pack/publish）:')}
  pack 与 publish 可分别设置，按域持久化，优先级高于配置/内置默认。
  ${chalk.dim('sjn registry                        # 查看当前域生效的 pack/publish')}
  ${chalk.dim('sjn registry set-pack <url>         # 设置拉取源')}
  ${chalk.dim('sjn registry set-publish <url>      # 设置发布目标（与 pack 可不同）')}
  ${chalk.dim('sjn registry reset                  # 重置为默认    -D <域> 针对指定域')}

${chalk.bold('短链(alias):')}
  把常用长命令取个短名，运行时自动展开，额外参数会追加在后面。
  ${chalk.dim('sjn alias set r "release --no-build"   # 定义 sjn r = sjn release --no-build')}
  ${chalk.dim('sjn r --dry-run                        # 等价 sjn release --no-build --dry-run')}
  ${chalk.dim('sjn alias           # 查看全部短链    sjn alias rm r   # 删除')}
`
  );

  return program;
}
