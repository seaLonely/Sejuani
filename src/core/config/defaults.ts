import { DomainConfig, DomainKey, DomainRoots, RegistriesConfig, SejuaniConfig } from './schema';

/**
 * Sejuani 标准（替代 rh.toml）：内置默认 registry 与工程/组件根路径。
 * 可被 sejuani.config.json 覆盖（见 ./loader）。
 *
 * 域(domain)：chery(奇瑞) / foton(福田) / saas。每个域各自对应一套
 * 工程仓库、组件仓库与 registry。切换域后，加载配置时会把该域的
 * roots/registries 展开到顶层，供所有流程直接使用。
 */

const WORKSPACE_ROOT = '/Users/cherish/Documents/workSpace/project';

/** 按域名生成一套默认 roots（<domain>-fed-workspce-rhea / <domain>-fed-lib-workspce-rhea） */
function defaultRoots(domain: string): DomainRoots {
  return {
    projects: {
      root: `${WORKSPACE_ROOT}/${domain}-fed-workspce-rhea`,
      packagesDir: 'workspace',
      depth: 1,
    },
    components: {
      root: `${WORKSPACE_ROOT}/${domain}-fed-lib-workspce-rhea`,
      packagesDir: 'workspace',
      depth: 1,
    },
  };
}

const CHERY_REGISTRIES: RegistriesConfig = {
  pack: 'https://npm.f6yc.com',
  publish: 'http://nexus-ditc.mychery.com/repository/chery-sumeida-npm/',
};

/** 内置各域配置。foton/saas 的路径与 publish 源为占位默认，可用 sejuani.config.json 覆盖。 */
export const DOMAINS: Record<DomainKey, DomainConfig> = {
  chery: {
    label: '奇瑞 (chery)',
    registries: CHERY_REGISTRIES,
    roots: {
      projects: {
        root: `${WORKSPACE_ROOT}/chery-fed-workspce-rhea`,
        packagesDir: 'workspace',
        depth: 1,
      },
      components: {
        root: `${WORKSPACE_ROOT}/chery-fed-lib-workspce-rhea`,
        packagesDir: 'workspace',
        depth: 1,
      },
    },
  },
  foton: {
    label: '福田 (foton)',
    registries: CHERY_REGISTRIES,
    roots: defaultRoots('foton'),
  },
  saas: {
    label: 'SaaS (saas)',
    registries: CHERY_REGISTRIES,
    roots: defaultRoots('saas'),
  },
};

/** 默认域 */
export const DEFAULT_DOMAIN: DomainKey = 'chery';

/**
 * 完整发布(release)默认构建步骤：在组件目录依次执行，完成后再 pack+publish。
 * 可在 sejuani.config.json 用 "buildSteps" 数组覆盖。
 */
export const DEFAULT_BUILD_STEPS: string[] = [
  'yarn install',
  'yarn lib',
  'gaia pub-isd prod',
];

/** 内置默认配置：默认展开为 chery 域 */
export const DEFAULT_CONFIG: SejuaniConfig = {
  registries: DOMAINS[DEFAULT_DOMAIN].registries,
  roots: DOMAINS[DEFAULT_DOMAIN].roots,
  domains: DOMAINS,
  activeDomain: DEFAULT_DOMAIN,
  buildSteps: DEFAULT_BUILD_STEPS,
};

export const CONFIG_FILENAME = 'sejuani.config.json';
