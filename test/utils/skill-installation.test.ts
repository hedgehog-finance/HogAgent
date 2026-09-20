import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installSkillDirectory } from '../../src/utils/skill-installation.ts';
const nativeFs = await vi.importActual<typeof import('node:fs')>('node:fs');

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync), rmSync: vi.fn(actual.rmSync) };
});

describe('Skill directory publication', () => {
  let root: string;
  const populate = (path: string, version = '2.0.0') => fs.writeFileSync(join(path, 'SKILL.md'), `---\nname: demo\ndescription: test\nversion: ${version}\n---\nVersion ${version}`);
  beforeEach(() => {
    vi.mocked(fs.renameSync).mockReset().mockImplementation(nativeFs.renameSync);
    vi.mocked(fs.rmSync).mockReset().mockImplementation(nativeFs.rmSync);
    root = fs.mkdtempSync(join(tmpdir(), 'hog-skill-publication-'));
  });
  afterEach(() => { nativeFs.rmSync(root, { recursive: true, force: true }); });

  it('never exposes or retains partially extracted new packages', () => {
    expect(() => installSkillDirectory(root, 'demo', staging => { populate(staging); throw new Error('CRC failed'); })).toThrow('CRC failed');
    expect(fs.readdirSync(root)).toEqual([]);
    expect(() => installSkillDirectory(root, 'demo', () => {})).toThrow('SKILL.md');
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('restores the old version when publishing the candidate fails', () => {
    fs.mkdirSync(join(root, 'demo')); populate(join(root, 'demo'), '1.0.0');
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (String(source).includes('.tmp-')) throw new Error('publication denied');
      nativeFs.renameSync(source, target);
    });
    expect(() => installSkillDirectory(root, 'demo', populate)).toThrow('publication denied');
    expect(fs.readFileSync(join(root, 'demo/SKILL.md'), 'utf8')).toContain('1.0.0');
    expect(fs.readdirSync(root)).toEqual(['demo']);
  });

  it('retains the committed new version and reports success if old-backup cleanup fails', () => {
    fs.mkdirSync(join(root, 'demo')); populate(join(root, 'demo'), '1.0.0');
    vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw new Error('backup cleanup denied'); });
    expect(installSkillDirectory(root, 'demo', populate)).toMatchObject({ installed: true, updated: true });
    expect(fs.readFileSync(join(root, 'demo/SKILL.md'), 'utf8')).toContain('2.0.0');
    expect(fs.readdirSync(root).filter(name => name.includes('.bak-'))).toHaveLength(1);
  });
});
