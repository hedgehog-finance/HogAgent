import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freezeMediaAttachments, mediaAttachments, readMediaAttachment } from '../../src/media/media-input.ts';

let root: string;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'media-boundary-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('media reference boundary', () => {
  it('strips payload properties and snapshots caller references before persistence', async () => {
    await mkdir(join(root, 'files'));
    await writeFile(join(root, 'files/图片 with spaces.png'), png);
    const input = { kind: 'image', path: 'files/图片 with spaces.png', data: 'UNTRUSTED_BASE64', source: { data: 'UNTRUSTED_BASE64' } };
    const references = mediaAttachments([input]);
    expect(references).toEqual([{ kind: 'image', path: input.path }]);
    input.path = 'files/other.png';
    expect(references[0]!.path).toBe('files/图片 with spaces.png');
    expect(JSON.stringify(await freezeMediaAttachments(references, root))).not.toContain('UNTRUSTED_BASE64');
  });
  it.each([{ path: '' }, { size: -1 }, { size: NaN }, { mimeType: {} }, { projectId: [] }, { sha256: 'invalid' }])('rejects invalid reference metadata %j', patch => {
    expect(() => mediaAttachments([{ kind: 'image', path: 'files/a.png', ...patch }])).toThrow('附件引用无效');
  });
  it.each(['workspace', 'project'])('rejects an upload root redirected outside the %s', async mode => {
    const base = join(root, mode);
    const outside = join(root, 'outside');
    await mkdir(base);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.png'), png);
    if (mode === 'project') await mkdir(join(base, 'data'));
    const upload = mode === 'project' ? 'data/uploads' : 'files';
    // Junctions exercise the directory boundary on Windows without symlink privilege.
    await symlink(outside, join(base, upload), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readMediaAttachment({ kind: 'image', path: upload + '/secret.png' }, base, mode === 'project' ? base : undefined)).rejects.toThrow('上传目录不属于当前工作区');
  });
  it('rejects a file on a sibling path sharing the upload directory prefix', async () => {
    await mkdir(join(root, 'files'));
    await mkdir(join(root, 'files-other'));
    await writeFile(join(root, 'files-other/a.png'), png);
    await expect(readMediaAttachment({ kind: 'image', path: 'files-other/a.png' }, root)).rejects.toThrow('附件不属于当前上传目录');
  });
  it('rejects directory references before opening them', async () => {
    await mkdir(join(root, 'files/dir.png'), { recursive: true });
    await expect(readMediaAttachment({ kind: 'image', path: 'files/dir.png' }, root)).rejects.toThrow('普通文件');
  });
});
