/** A Skill name must remain a child entry on every supported filesystem. */
export function validateSkillName(name: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(name) && !name.includes('..') && !name.endsWith('.');
}
