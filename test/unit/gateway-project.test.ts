import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gatewayProjectsDirectory, projectDeliverablesDirectory, resolveGatewayProject } from '../../src/gateway-project.ts';
import { createDefaultRuntimeGrant } from '../../src/tools/runtime-grants.ts';
import { recordArtifactRoleForConfig, resolveArtifactFile } from '../../src/artifacts/artifact-protocol.ts';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for(const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('Gateway managed project directories', () => {
  it('grants workspace and current-user projects equally without confusing the installation root', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'hog-project-runtime-'))); dirs.push(base);
    const workspace = join(base,'workspace'), projects = join(workspace,'projects'), project = join(projects,'one');
    for(const dir of [workspace,project]) mkdirSync(dir,{recursive:true});
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED','1'); vi.stubEnv('HOGAGENT_GATEWAY_PROJECTS_DIR',projects);
    expect(gatewayProjectsDirectory()).toBe(projects);
    expect(resolveGatewayProject('one',project)).toBe(project);
    expect(()=>resolveGatewayProject('outside',workspace)).toThrow('outside');
    const grant=createDefaultRuntimeGrant({platform:'darwin',workspaceDir:workspace,projectRoot:join(base,'installation'),tempDir:join(workspace,'tmp'),shells:['/bin/bash'],baseEnvironment:process.env});
    expect(grant.writablePaths).toContain(workspace); expect(grant.writablePaths).not.toContain(projects);
    expect(grant.writablePaths).not.toContain(base); expect(grant.writablePaths).not.toContain(join(base,'installation'));
    expect(grant.readOnlyPaths).toContain('/System');
    expect(projectDeliverablesDirectory()).toBe('artifacts');
    const output=join(project,'artifacts','result.md'); mkdirSync(join(project,'artifacts')); writeFileSync(output,'result');
    expect(() => recordArtifactRoleForConfig({ workspaceDir:workspace,sessionTaskDir:workspace,projectDir:project,manifestOwner:'gateway' } as any, output, 'intermediate')).toThrow('project policy');
    expect(existsSync(join(project,'.hedgehog','artifact-overrides.json'))).toBe(false);
    expect(resolveArtifactFile(output,{workspaceDir:workspace,sessionTaskDir:workspace,projectDir:project,manifestOwner:'gateway'})).toMatchObject({role:'deliverable',root:'project',rootRelative:'artifacts/result.md'});
  });
  it('keeps standalone project layout and refuses prompt-only authorization', () => {
    vi.stubEnv('HOGAGENT_GATEWAY_MANAGED',''); vi.stubEnv('HOGAGENT_GATEWAY_PROJECTS_DIR','/untrusted');
    expect(gatewayProjectsDirectory()).toBeUndefined(); expect(projectDeliverablesDirectory()).toBe('publish');
    expect(()=>resolveGatewayProject('project','/untrusted/project')).toThrow('incomplete');
  });
});
