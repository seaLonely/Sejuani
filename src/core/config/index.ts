/**
 * 配置模块统一出口：类型(schema) + 内置默认(defaults) + 加载与域展开(loader)。
 * 外部一律 `import { ... } from '<相对路径>/core/config'`。
 */
export * from './schema';
export * from './defaults';
export * from './loader';
