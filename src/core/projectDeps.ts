import fs from 'fs';
import { Component } from '../types';

export type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies';

export interface ProjectDep {
  name: string;
  /** 声明的版本区间，如 ^1.0.1 */
  range: string;
  section: DepSection;
}

const SECTIONS: DepSection[] = ['dependencies', 'devDependencies'];

/**
 * 读取工程 package.json 的 dependencies + devDependencies。
 */
export function readProjectDeps(project: Component): ProjectDep[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(fs.readFileSync(project.packageJsonPath, 'utf8'));
  } catch {
    return [];
  }
  const deps: ProjectDep[] = [];
  for (const section of SECTIONS) {
    const block = pkg[section];
    if (block && typeof block === 'object') {
      for (const [name, range] of Object.entries(block as Record<string, string>)) {
        deps.push({ name, range: String(range), section });
      }
    }
  }
  return deps;
}
