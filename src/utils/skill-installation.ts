import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseSkillFrontmatter } from '../skill-loader.ts';
import { validateSkillName } from './skill-name.ts';
import { readSkillVersion, compareSemver } from './skill-version.ts';
import { createLogger } from './logger.ts';

const log = createLogger('skill-installation');

/** Both Git and ZIP publish only a completely prepared, discoverable Skill. */
export function installSkillDirectory(root: string, name: string, populate: (staging: string) => void): {
  installed: boolean; updated: boolean; incomingVersion: string; existingVersion: string;
} {
  if (!validateSkillName(name)) throw new Error('Invalid skill name');
  const destination = join(root, name);
  let existed = false;
  try {
    const stat = lstatSync(destination);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Installed Skill must be a real directory');
    existed = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(root, { recursive: true });
  const staging = join(root, `.${name}.tmp-${randomUUID()}`);
  const backup = join(root, `.${name}.bak-${randomUUID()}`);
  const cleanup = (path: string): void => {
    try { rmSync(path, { recursive: true, force: true }); }
    catch (error) { log.warn('Skill temporary directory retained for cleanup', { path, error: String(error) }); }
  };
  mkdirSync(staging);
  try {
    populate(staging);
    const entry = join(staging, 'SKILL.md');
    const stat = lstatSync(entry, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('SKILL.md must exist as a regular file');
    const skill = parseSkillFrontmatter(readFileSync(entry, 'utf8'));
    if (!skill?.name || !skill.description) throw new Error('SKILL.md must include name and description frontmatter');
    const incomingVersion = readSkillVersion(staging);
    const existingVersion = existed ? readSkillVersion(destination) : '0.0.0';
    if (existed && compareSemver(incomingVersion, existingVersion) <= 0) {
      return { installed: false, updated: false, incomingVersion, existingVersion };
    }
    if (existed) renameSync(destination, backup);
    try { renameSync(staging, destination); }
    catch (error) {
      if (existed) renameSync(backup, destination);
      throw error;
    }
    // Publication is complete. Cleanup failure cannot invalidate the installed
    // version or attempt to rename the old nonempty directory over the new one.
    if (existed) cleanup(backup);
    return { installed: true, updated: existed, incomingVersion, existingVersion };
  } finally { cleanup(staging); }
}
