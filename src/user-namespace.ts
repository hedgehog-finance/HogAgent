import { createHash } from 'node:crypto';

/** Same portable namespace contract as Gateway; never use this as an identity. */
export function userDirectoryName(userId: string): string {
  if (typeof userId !== 'string' || !userId.trim()) throw new Error('Authenticated user is required');
  if (/^[a-z0-9][a-z0-9_-]{0,127}$/.test(userId) && userId !== 'system'
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(userId)) return userId;
  return `user~${createHash('sha256').update(userId, 'utf8').digest('hex')}`;
}
