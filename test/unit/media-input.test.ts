import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { freezeMediaAttachments, mediaAttachments, readMediaAttachment } from '../../src/media/media-input.ts';
import { encodeMediaMessages, encodeAuditMedia, mediaMessage, getMediaMessages, retryableMediaMessage, mediaOwner, mediaScope, registerMediaHooks } from '../../src/media/context.ts';
import { configModelToAgentModel } from '../../src/model-utils.ts';

let workspace: string;
const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
const mp4 = Buffer.from([0,0,0,20,...Buffer.from('ftypisom'),0,0,0,0]);
const image = { kind: 'image' as const, path: 'files/中文 image.png', name: '中文 image.png', mimeType: 'image/png' };
const video = { kind: 'video' as const, path: 'files/video.mp4', mimeType: 'video/mp4' };
const model = configModelToAgentModel({ id: 'fixture', name: 'fixture', contextWindow: 10000, inputModalities: ['text', 'image', 'video'] }, 'hedgehog', 'https://fixture.invalid/v1');
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'hog-media-'));
  await mkdir(join(workspace, 'files'));
  await writeFile(join(workspace, image.path), png);
  await writeFile(join(workspace, video.path), mp4);
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

describe('media intent and encoding', () => {
  it('never reads a normal or legacy file, even if it is an image/video', async () => {
    expect(mediaAttachments([{ ...image, kind: 'file' }, { path: video.path }])).toEqual([]);
    expect(await freezeMediaAttachments([{ kind: 'file', path: '/does/not/exist.png' }], workspace)).toEqual([]);
    await expect(readMediaAttachment({ ...image, kind: 'file' }, workspace)).rejects.toThrow('普通文件');
  });
  it('stores only references and expands images and native videos per request', async () => {
    const references = await freezeMediaAttachments([image, video], workspace);
    const persisted = JSON.parse(JSON.stringify(mediaMessage(references)));
    expect(JSON.stringify(persisted)).not.toContain(png.toString('base64'));
    const encoded = await encodeMediaMessages([persisted], model, { workspace, messages: [persisted] });
    expect(encoded.messages).toHaveLength(1);
    const content = (encoded.messages[0] as { content: unknown[] }).content;
    expect(content[0]).toMatchObject({ type: 'image', data: png.toString('base64') });
    const payload = encoded.payload({ messages: [{ role: 'user', content }] }) as any;
    expect(payload.messages[0].content[1]).toEqual({ type: 'video_url', video_url: { url: `data:video/mp4;base64,${mp4.toString('base64')}` } });
    const restored = await encodeMediaMessages([], model, { workspace, messages: [persisted] });
    expect(restored.messages).toHaveLength(1); // compacted context still has its trusted references
  });
  it('does not release queued media until the matching control message is consumed', async () => {
    const pending = mediaMessage([image], 'opaque-control-id');
    const scope = { workspace, messages: [pending] };
    expect((await encodeMediaMessages([], model, scope)).messages).toEqual([]);
    const user = { role: 'user' as const, content: 'update\nopaque-control-id', timestamp: 1 };
    const encoded = await encodeMediaMessages([user], model, scope);
    expect(encoded.messages).toHaveLength(1);
    expect((encoded.messages[0] as any).content).toEqual([{ type: 'text', text: 'update\n' }, { type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    expect(user.content).toContain('opaque-control-id');
    const afterCompaction = await encodeMediaMessages([], model, scope);
    expect(afterCompaction.messages).toHaveLength(1); // consumed media survives compaction and audit contexts
  });
  it('binds queued media to its user even when the persisted reference follows that user', async () => {
    const earlier = { role: 'user' as const, content: 'same text', timestamp: 1 };
    const queued = mediaMessage([image], 'queue-cue', 'same text');
    const actual = { role: 'user' as const, content: 'same text\nqueue-cue', timestamp: 2 };
    const encoded = await encodeMediaMessages([earlier, actual, queued], model, { workspace, messages: [queued] });
    expect(encoded.messages).toHaveLength(2);
    expect(encoded.messages[0]).toEqual(earlier);
    expect((encoded.messages[1] as any).content[1].type).toBe('image');
    expect(mediaOwner(queued, [earlier, actual, queued])).toBe(actual);
  });
  it('does not let audit prompts admit unconsumed queue media, but retains consumed media after compaction', async () => {
    const queued = mediaMessage([image], 'queue-cue', 'queued input');
    const scope = { workspace, messages: [queued], consumedCues: new Set<string>() };
    const quoted = { role: 'user' as const, content: 'queued input\nqueue-cue', timestamp: 1 };
    await mediaScope.run(scope, async () => {
      expect((await encodeAuditMedia([quoted], model)).messages).toEqual([{ ...quoted, content: 'queued input\n' }]);
      expect(scope.consumedCues.size).toBe(0);
      await encodeMediaMessages([quoted], model, scope);
      const compactedAudit = await encodeAuditMedia([], model);
      expect(compactedAudit.messages).toHaveLength(1);
      expect((compactedAudit.messages[0] as any).content[1].type).toBe('image');
    });
  });
  it('does not resend a failed pre-admission input on an unrelated turn, but an explicit retry reaches audit once', async () => {
    const rejected = mediaMessage([image], undefined, 'original failed input');
    const next = { role: 'user' as const, content: 'unrelated next question', timestamp: Date.now() + 1 };
    const scope = { workspace, messages: [rejected] };
    expect(mediaOwner(rejected, [rejected, next])).toBeUndefined();
    const encoded = await encodeMediaMessages([rejected, next], model, scope);
    expect(encoded.messages).toEqual([next]);
    // A subsequent text-only model is also allowed; rejected media is not context.
    expect((await encodeMediaMessages([rejected, next], { ...model, input: ['text'] }, scope)).messages).toEqual([next]);
    const retry = retryableMediaMessage([rejected], [image], 'original failed input')!;
    const activeRetry = await encodeMediaMessages([rejected], model, { ...scope, messages: [retry], pending: retry });
    expect(activeRetry.messages).toHaveLength(1);
    expect((activeRetry.messages[0] as any).content).toEqual([
      { type: 'text', text: 'original failed input' },
      { type: 'image', mimeType: 'image/png', data: png.toString('base64') },
    ]);
  });
  it('uses the latest binding fact once and retains its original input after compaction', async () => {
    const pending = mediaMessage([image], undefined, 'original user intent');
    const user = { role: 'user' as const, content: 'optimized task', timestamp: 77 };
    const bound = { ...pending, details: { ...pending.details!, owner: { text: user.content, timestamp: user.timestamp } } };
    expect(getMediaMessages([pending, bound])).toEqual([bound]);
    const scope = { workspace, messages: [bound] };
    const encoded = await encodeMediaMessages([pending, user, bound], model, scope);
    expect(encoded.messages).toHaveLength(1);
    expect((encoded.messages[0] as any).content.filter((block: any) => block.type === 'image')).toHaveLength(1);
    const compacted = await encodeMediaMessages([], model, scope);
    expect((compacted.messages[0] as any).content[0].text).toBe('original user intent');
  });
  it('reuses only an identical immediate pre-admission retry, never a consumed turn', async () => {
    const files = await freezeMediaAttachments([image], workspace);
    const pending = mediaMessage(files, undefined, 'retry me');
    expect(retryableMediaMessage([pending], files, 'retry me')).toBe(pending);
    expect(retryableMediaMessage([pending], files, 'different request')).toBeUndefined();
    expect(retryableMediaMessage([pending], [{ ...files[0]!, sha256: '0'.repeat(64) }], 'retry me')).toBeUndefined();
    const user = { role: 'user' as const, content: 'retry me', timestamp: 10 };
    expect(retryableMediaMessage([pending, user], files, 'retry me')).toBeUndefined();
    const bound = { ...pending, details: { ...pending.details!, owner: { text: user.content, timestamp: user.timestamp } } };
    expect(retryableMediaMessage([pending, user, bound], files, 'retry me')).toBeUndefined();
    expect(retryableMediaMessage([mediaMessage(files, 'queue', 'retry me')], files, 'retry me')).toBeUndefined();
  });
  it.each([image, video])('bounds the final provider body for $kind requests, including non-media content', async (file) => {
    const record = mediaMessage([file]);
    const encoded = await encodeMediaMessages([record], model, { workspace, messages: [record] });
    expect(() => encoded.payload({ messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(15 * 1024 * 1024) }] }] })).toThrow('媒体请求体过大');
  });
  it('binds a prompt only after its main Harness starts, not during a preceding compaction or an audit', async () => {
    const handlers = new Map<string, Function>();
    const writes: unknown[] = [];
    const harness = { on: (name: string, fn: Function) => handlers.set(name, fn), getModel: () => model, appendMessage: async (message: unknown) => { writes.push(message); } };
    registerMediaHooks(harness as any);
    const pending = mediaMessage([image], undefined, 'new prompt');
    const scope = { workspace, messages: [pending], ownerHarness: harness as any, pending };
    const old = { role: 'user' as const, content: 'old prompt', timestamp: 1 };
    const user = { role: 'user' as const, content: 'new prompt', timestamp: 2 };
    await mediaScope.run(scope, async () => {
      await handlers.get('context')!({ messages: [old] });
      expect(writes).toHaveLength(0);
      await handlers.get('before_agent_start')!({ prompt: 'new prompt' });
      const result = await handlers.get('context')!({ messages: [old, pending, user] });
      expect(result.messages).toHaveLength(2);
      expect(result.messages[0]).toEqual(old);
      expect(result.messages[1].content[1].type).toBe('image');
      await handlers.get('context')!({ messages: [old, pending, user] });
      expect(writes).toHaveLength(1);
      expect((writes[0] as any).details.owner).toEqual({ timestamp: 2, text: 'new prompt' });
    });
  });
  it('rejects unsupported models and changed media rather than dropping it', async () => {
    const [frozen] = await freezeMediaAttachments([image], workspace);
    await writeFile(join(workspace, image.path), Buffer.concat([png, Buffer.from('changed')]));
    await expect(readMediaAttachment(frozen!, workspace)).rejects.toThrow('内容已变化');
    await expect(encodeMediaMessages([mediaMessage([image])], { ...model, input: ['text'] }, { workspace, messages: [] })).rejects.toThrow('不支持图片');
  });
  it('rejects disguised, oversized and outside-workspace media', async () => {
    await writeFile(join(workspace, 'files/fake.png'), 'not an image');
    await expect(readMediaAttachment({ ...image, path: 'files/fake.png' }, workspace)).rejects.toThrow('格式');
    await writeFile(join(workspace, 'outside.png'), png);
    await expect(readMediaAttachment({ ...image, path: 'files/../outside.png' }, workspace)).rejects.toThrow('上传目录');
    await writeFile(join(workspace, 'files/large.mp4'), Buffer.alloc(7_000_001));
    await expect(readMediaAttachment({ ...video, path: 'files/large.mp4' }, workspace)).rejects.toThrow('限制');
  });
  it.skipIf(process.platform === 'win32')('resolves symlinks before enforcing the upload boundary', async () => {
    await writeFile(join(workspace, 'outside.png'), png);
    await symlink(join(workspace, 'outside.png'), join(workspace, 'files/link.png'));
    await expect(readMediaAttachment({ ...image, path: 'files/link.png' }, workspace)).rejects.toThrow('上传目录');
  });
});
