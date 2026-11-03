import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSkillDisabledInDevelopment } from '../../src/development-skill-policy.ts';
import { loadSkillsFromDirs } from '../../src/skill-loader.ts';

const names = ['hedgehog-company-index-data', 'hedgehog-macro-industry-data', 'hedgehog-news-reports'];
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

describe('temporary development Skill restriction', () => {
  it('explicit Skills-off is development-only and blocks all Skills', () => {
    for (const name of [...names, 'fin-calc', 'custom-skill']) {
      expect(isSkillDisabledInDevelopment(name,{HEDGEHOG_DEV_ENDPOINTS:'1',HEDGEHOG_DEV_SKILLS_MODE:'off'})).toBe(true);
      expect(isSkillDisabledInDevelopment(name,{NODE_ENV:'production',HEDGEHOG_DEV_ENDPOINTS:'1',HEDGEHOG_DEV_SKILLS_MODE:'off'})).toBe(false);
    }
  });
  it('disables only the three named clients in explicitly isolated development', () => {
    for (const name of names) {
      expect(isSkillDisabledInDevelopment(name,{HEDGEHOG_DEV_ENDPOINTS:'1',NODE_ENV:'development'})).toBe(true);
      expect(isSkillDisabledInDevelopment(name,{HEDGEHOG_DEV_ENDPOINTS:'1',NODE_ENV:'production'})).toBe(false);
      expect(isSkillDisabledInDevelopment(name,{NODE_ENV:'development'})).toBe(false);
      expect(isSkillDisabledInDevelopment(name,{NODE_ENV:'development',HEDGEHOG_DEV_ENDPOINTS:'1',HEDGEHOG_CIWEI_AI_BASE_URL:'https://api.ciweiai.com/api'})).toBe(false);
      expect(isSkillDisabledInDevelopment(name,{NODE_ENV:'development',HEDGEHOG_DEV_ENDPOINTS:'1',HEDGEHOG_DEV_SKILLS_MODE:'off',HEDGEHOG_CIWEI_AI_BASE_URL:'https://api.ciweiai.com/api'})).toBe(true);
    }
    expect(isSkillDisabledInDevelopment('fin-calc',{HEDGEHOG_DEV_ENDPOINTS:'1'})).toBe(false);
  });

  it('startup and reload both exclude them without deleting files; production still loads them', () => {
    const root = mkdtempSync(join(tmpdir(),'hog-dev-skills-')); roots.push(root);
    const install = join(root,'install');
    const workspace = join(root,'workspace');
    vi.stubEnv('HOGAGENT_PROJECT_ROOT',install);
    for (const parent of [join(install,'skills'),join(workspace,'.hogagent','skills')]) {
      for (const name of [...names,'fin-calc']) {
        mkdirSync(join(parent,name),{recursive:true});
        writeFileSync(join(parent,name,'SKILL.md'),`---\nname: ${name}\ndescription: Fixture\n---\n# Fixture\n`);
      }
    }
    vi.stubEnv('NODE_ENV','development'); vi.stubEnv('HEDGEHOG_DEV_ENDPOINTS','1');
    for (let i=0;i<2;i++) expect(loadSkillsFromDirs(workspace).map(skill=>skill.name)).toEqual(['fin-calc']);
    for(const name of names) expect(existsSync(join(workspace,'.hogagent','skills',name,'SKILL.md'))).toBe(true);
    vi.stubEnv('HEDGEHOG_CIWEI_AI_BASE_URL','https://api.ciweiai.com/api');
    expect(loadSkillsFromDirs(workspace).map(skill=>skill.name).sort()).toEqual([...names,'fin-calc'].sort());
    vi.stubEnv('HEDGEHOG_DEV_SKILLS_MODE','off');
    expect(loadSkillsFromDirs(workspace)).toEqual([]);
    vi.stubEnv('NODE_ENV','production');
    expect(loadSkillsFromDirs(workspace).map(skill=>skill.name).sort()).toEqual([...names,'fin-calc'].sort());
  });
});
