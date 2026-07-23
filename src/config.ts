/**
 * Sejuani 标准（替代 rh.toml）：内置默认 registry 与工程/组件根路径。
 * 可被 sejuani.config.json 覆盖（见 core/configLoader.ts）。
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

export interface SejuaniConfig {
  registries: RegistriesConfig;
  roots: {
    projects: RootConfig;
    components: RootConfig;
  };
}

/** 内置默认配置：当前机器上的两条 rhea 路径 */
export const DEFAULT_CONFIG: SejuaniConfig = {
  registries: {
    pack: 'https://npm.f6yc.com',
    publish: 'http://nexus-ditc.mychery.com/repository/chery-sumeida-npm/',
  },
  roots: {
    projects: {
      root: '/Users/cherish/Documents/workSpace/project/chery-fed-workspce-rhea',
      packagesDir: 'workspace',
      depth: 1,
    },
    components: {
      root: '/Users/cherish/Documents/workSpace/project/chery-fed-lib-workspce-rhea',
      packagesDir: 'workspace',
      depth: 1,
    },
  },
};

export const CONFIG_FILENAME = 'sejuani.config.json';
