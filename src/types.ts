export interface Component {
  /** 组件目录名，例如 "code-frame" */
  name: string;
  /** 组件根目录绝对路径 */
  dir: string;
  /** package.json 绝对路径 */
  packageJsonPath: string;
  /** yarn.lock 绝对路径（不存在则为 null） */
  yarnLockPath: string | null;
  /** package.json 中的 name 字段 */
  pkgName?: string;
  /** package.json 中的 version 字段 */
  pkgVersion?: string;
}

/** 单个文件的一次变更计划 */
export interface FileChange {
  filePath: string;
  before: string;
  after: string;
  /** 变更条目数（例如替换了多少个 url） */
  hits: number;
  /** 简短描述，用于列表展示 */
  summary: string;
}

/** 一个组件下所有文件的变更计划 */
export interface ComponentChange {
  component: Component;
  files: FileChange[];
}
