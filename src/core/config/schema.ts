/**
 * Sejuani 配置的类型定义（schema）。
 * 内置默认值见 ./defaults，加载与域展开见 ./loader。
 */

export interface RootConfig {
  /** 工程/组件所在的根目录 */
  root: string;
  /** 包目录相对根的子目录，例如 rhea 的 "workspace"。若不存在则直接扫描 root */
  packagesDir: string;
  /** 扫描深度（fast-glob deep），默认 1，即只取 <packagesDir>/*\/package.json */
  depth: number;
}

export interface RegistriesConfig {
  /** npm pack 拉取源 */
  pack: string;
  /** npm publish 目标 */
  publish: string;
}

export interface DomainRoots {
  projects: RootConfig;
  components: RootConfig;
}

/** 一个业务域的完整配置：显示名 + registry + 工程/组件根 */
export interface DomainConfig {
  /** 展示名，如「奇瑞 (chery)」 */
  label: string;
  registries: RegistriesConfig;
  roots: DomainRoots;
}

/** 支持的域标识 */
export type DomainKey = 'chery' | 'foton' | 'saas';

export interface SejuaniConfig {
  /** 生效 registry（= 当前域的 registries，加载时展开） */
  registries: RegistriesConfig;
  /** 生效 roots（= 当前域的 roots，加载时展开） */
  roots: DomainRoots;
  /** 全部域配置 */
  domains: Record<string, DomainConfig>;
  /** 当前域标识（可被 ~/.sejuani/state.json 覆盖） */
  activeDomain: string;
  /** 完整发布(release)时，pack/publish 之前在组件目录依次执行的构建步骤 */
  buildSteps: string[];
}
