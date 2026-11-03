// GENERATED from contracts/media-input.ts. Do not edit.
import { lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** Missing kind is a legacy file reference, never an inference input. */
export interface MediaAttachment {
  kind?: 'file' | 'image' | 'video';
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
  projectId?: string | null;
  sha256?: string;
}
export interface MediaCapabilities {
  image: boolean;
  video: boolean;
  limits?: typeof MEDIA_LIMITS;
  mimeTypes?: typeof MEDIA_MIME_TYPES;
}
export const MEDIA_LIMITS = { image: 5_000_000, video: 7_000_000 } as const;
export const MEDIA_MIME_TYPES = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/quicktime'],
} as const;

export function mediaCapabilities(image: boolean, video: boolean): MediaCapabilities {
  return { image, video, limits: MEDIA_LIMITS, mimeTypes: MEDIA_MIME_TYPES };
}

export function mediaAttachments(value: unknown): MediaAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) throw new Error('每条消息最多支持 10 个附件');
  return value.flatMap((item): MediaAttachment[] => {
    if (!item || typeof item !== 'object' || typeof item.path !== 'string'
      || !item.path.trim() || item.path.includes('\0')
      || ![undefined, 'file', 'image', 'video'].includes(item.kind)) throw new Error('附件引用无效');
    if (item.kind !== 'image' && item.kind !== 'video') return [];
    if (['name', 'mimeType'].some(key => item[key] !== undefined && typeof item[key] !== 'string')
      || (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 0))
      || (item.projectId !== undefined && item.projectId !== null && typeof item.projectId !== 'string')
      || (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)))) throw new Error('附件引用无效');
    // Persist only reference fields; arbitrary RPC properties must not smuggle
    // binary bodies into history or retain caller-owned mutable objects.
    return [{ kind: item.kind, path: item.path,
      ...(item.name !== undefined ? { name: item.name } : {}),
      ...(item.mimeType !== undefined ? { mimeType: item.mimeType } : {}),
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.projectId !== undefined ? { projectId: item.projectId } : {}),
      ...(item.sha256 !== undefined ? { sha256: item.sha256 } : {}),
    }];
  });
}

export function assertMediaCapabilities(files: MediaAttachment[], capabilities?: Partial<MediaCapabilities>): void {
  for (const file of files) {
    if (file.kind !== 'image' && file.kind !== 'video') continue;
    if (capabilities?.[file.kind] !== true) throw new Error(`当前 Agent 或模型不支持${file.kind === 'image' ? '图片' : '视频'}输入，请切换模型或将附件改为普通文件`);
  }
}

function detectedMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (['isom', 'iso2', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V '].includes(brand)) return 'video/mp4';
  }
  return undefined;
}

/** Resolve against the server-owned upload root, never a client supplied root. */
export async function readMediaAttachment(file: MediaAttachment, workspace: string, projectDir?: string): Promise<{ path: string; mimeType: string; data: string; sha256: string }> {
  if (file.kind !== 'image' && file.kind !== 'video') throw new Error('普通文件不能作为模型媒体输入');
  const projectFile = file.path.replace(/\\/g, '/').startsWith('data/uploads/');
  if (projectFile && !projectDir) throw new Error('附件不属于当前项目');
  const base = projectFile ? projectDir! : workspace;
  const realBase = await realpath(base);
  const uploadRoot = await realpath(resolve(base, projectFile ? 'data/uploads' : 'files'));
  const rootChild = relative(realBase, uploadRoot);
  if (!rootChild || rootChild === '..' || rootChild.startsWith(`..${sep}`) || isAbsolute(rootChild)) throw new Error('上传目录不属于当前工作区');
  const target = await realpath(isAbsolute(file.path) ? file.path : resolve(base, file.path));
  const child = relative(uploadRoot, target);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('附件不属于当前上传目录');
  const expected = await lstat(target);
  if (!expected.isFile()) throw new Error('媒体引用必须指向普通文件');
  const handle = await open(target, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const stat = await handle.stat();
    if (stat.dev !== expected.dev || stat.ino !== expected.ino || await realpath(target) !== target) throw new Error('附件路径在读取前发生变化，请重新添加附件');
    if (!stat.isFile() || stat.size === 0 || stat.size > MEDIA_LIMITS[file.kind]) throw new Error(`媒体文件为空或超过 ${MEDIA_LIMITS[file.kind]} 字节限制`);
    // A concurrently growing file must not turn a bounded upload into an
    // unbounded allocation after the stat check.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (bytes.length > MEDIA_LIMITS[file.kind]) throw new Error('媒体文件超过大小限制');
    const after = await handle.stat();
    if (bytes.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('媒体文件读取期间发生变化，请重新添加附件');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (file.sha256 !== undefined && file.sha256 !== sha256) throw new Error('媒体文件内容已变化，请重新添加附件');
    const mimeType = detectedMime(bytes);
    if (!mimeType || !(MEDIA_MIME_TYPES[file.kind] as readonly string[]).includes(mimeType)) throw new Error('不支持该媒体格式，请通过普通文件入口上传');
    if (file.mimeType && file.mimeType !== 'application/octet-stream' && file.mimeType !== mimeType) throw new Error('媒体类型与文件内容不一致');
    return { path: target, mimeType, data: bytes.toString('base64'), sha256 };
  } finally { await handle.close(); }
}

export async function freezeMediaAttachments(value: unknown, workspace: string, projectDir?: string): Promise<MediaAttachment[]> {
  const files = mediaAttachments(value);
  const frozen: MediaAttachment[] = [];
  let bytes = 0;
  for (const file of files) {
    const media = await readMediaAttachment(file, workspace, projectDir);
    bytes += media.data.length;
    if (bytes > 15 * 1024 * 1024) throw new Error('媒体请求体过大，请减少附件');
    frozen.push({ ...file, mimeType: media.mimeType, sha256: media.sha256 });
  }
  return frozen;
}
