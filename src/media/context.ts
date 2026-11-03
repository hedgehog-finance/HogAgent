import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { AgentHarness } from '../vendor/agent/harness/agent-harness.ts';
import type { AgentMessage } from '../vendor/agent/types.ts';
import type { CustomMessage } from '../vendor/agent/harness/messages.ts';
import type { Model, Message, TextContent, ImageContent } from '../vendor/ai/base.ts';
import { assertMediaCapabilities, mediaCapabilities, mediaAttachments, readMediaAttachment, type MediaAttachment } from './media-input.ts';

const MEDIA_MESSAGE = 'hogagent.media.v1';
export type MediaMessage = CustomMessage<{ attachments: MediaAttachment[]; id?: string; text?: string; cue?: string; owner?: { timestamp: number; text: string } }>;
export interface MediaScope { workspace: string; projectDir?: string; messages: MediaMessage[]; consumedCues?: Set<string>; ownerHarness?: AgentHarness; pending?: MediaMessage; pendingPrompt?: string }
export const activeMediaScopes = new WeakMap<AgentHarness, MediaScope>();
export const mediaScope = new AsyncLocalStorage<MediaScope>();
export const modelMediaCapabilities = (model: Model<any>) => mediaCapabilities(
  model.input?.includes('image') === true,
  model.api === 'openai-completions' && (model as Model<any> & { supportsVideoInput?: boolean }).supportsVideoInput === true,
);
export function mediaMessage(files: MediaAttachment[], cue?: string, text?: string): MediaMessage {
  return { role: 'custom', customType: MEDIA_MESSAGE, display: false, content: 'User media attachments', details: { id: randomUUID(), attachments: files, ...(cue ? { cue } : {}), ...(text !== undefined ? { text } : {}) }, timestamp: Date.now() };
}
export function isMediaMessage(message: AgentMessage): message is MediaMessage {
  return message.role === 'custom' && message.customType === MEDIA_MESSAGE;
}
export function getMediaMessages(messages: AgentMessage[]): MediaMessage[] {
  const records = new Map<string, MediaMessage>();
  for (const message of messages) if (isMediaMessage(message)) records.set(message.details?.id ?? JSON.stringify([message.timestamp, message.details]), message);
  return [...records.values()];
}
export function isUnboundMediaMessage(message: MediaMessage): boolean {
  return message.details?.text !== undefined && !message.details.owner && !message.details.cue;
}
/** Only an immediately retried input that never entered a native turn is reusable. */
export function retryableMediaMessage(messages: AgentMessage[], files: MediaAttachment[], text: string): MediaMessage | undefined {
  const last = messages.at(-1);
  return last && isMediaMessage(last) && last.details?.id && isUnboundMediaMessage(last)
    && last.details.text === text && JSON.stringify(last.details.attachments) === JSON.stringify(files) ? last : undefined;
}
export function mediaUserText(message: AgentMessage): string {
  return message.role === 'user' ? typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
}
export function mediaOwner(message: MediaMessage, messages: AgentMessage[]): AgentMessage | undefined {
  const details = message.details;
  if (details?.owner) return messages.find(item => item.role === 'user' && item.timestamp === details.owner!.timestamp && mediaUserText(item) === details.owner!.text);
  if (details?.cue) return messages.find(item => item.role === 'user' && mediaUserText(item).includes(details.cue!));
  // Only legacy records use adjacency. New, unbound records own their original
  // input explicitly, so pre-classification failures cannot attach to a later turn.
  if (details?.text !== undefined) return undefined;
  const index = messages.findIndex(item => item === message || (isMediaMessage(item) && item.details?.id && item.details.id === details?.id));
  return index < 0 ? undefined : messages.slice(index + 1).find(item => item.role === 'user');
}

/** A fresh encoder per request prevents markers from leaking across turns. */
export async function encodeMediaMessages(messages: AgentMessage[], model: Model<any>, scope = mediaScope.getStore(), consumeQueuedMedia = true) {
  const videos = new Map<string, { type: 'video_url'; video_url: { url: string } }>();
  if (!scope) return { messages, payload: (value: unknown) => value };
  const records = getMediaMessages([...messages, ...scope.messages]);
  const originals = messages.filter(message => !isMediaMessage(message));
  const expanded = originals.map(message => ({ ...message })) as AgentMessage[];
  const restored: AgentMessage[] = [];
  let mediaBytes = 0;
  for (const message of records) {
    const details = message.details;
    // A rejected pre-admission input remains visible in history but is not part
    // of subsequent requests. Only its active attempt may send it to an audit.
    if (isUnboundMediaMessage(message) && message !== scope.pending
      && (!details?.id || details.id !== scope.pending?.details?.id)) continue;
    const owner = mediaOwner(message, messages);
    if (details?.cue) {
      if (owner && consumeQueuedMedia) (scope.consumedCues ??= new Set()).add(details.cue);
      if (!scope.consumedCues?.has(details.cue)) continue;
    }
    const files = mediaAttachments(details?.attachments);
    assertMediaCapabilities(files, modelMediaCapabilities(model));
    const content: (TextContent | ImageContent)[] = [];
    for (const file of files) {
      const media = await readMediaAttachment(file, scope.workspace, scope.projectDir);
      mediaBytes += media.data.length;
      if (mediaBytes > 15 * 1024 * 1024) throw new Error('媒体请求体过大，请减少附件或开始新会话');
      if (file.kind === 'image') content.push({ type: 'image', mimeType: media.mimeType, data: media.data });
      else {
        const marker = `hogagent-video:${randomUUID()}`;
        videos.set(marker, { type: 'video_url', video_url: { url: `data:${media.mimeType};base64,${media.data}` } });
        content.push({ type: 'text', text: marker });
      }
    }
    if (!content.length) continue;
    const target = owner ? expanded[originals.indexOf(owner)] : undefined;
    if (target?.role === 'user') {
      target.content = [...(typeof target.content === 'string' ? [{ type: 'text' as const, text: target.content }] : target.content), ...content];
    } else {
      restored.push({ role: 'user', content: [...(details?.text !== undefined ? [{ type: 'text' as const, text: details.text }] : []), ...content], timestamp: message.timestamp });
    }
  }
  expanded.unshift(...restored);
  const cues = records.flatMap(message => message.details?.cue ? [message.details.cue] : []);
  for (const message of expanded) if (message.role === 'user') {
    if (typeof message.content === 'string') message.content = cues.reduce((text, cue) => text.replace(cue, ''), message.content);
    else message.content = message.content.map(block => block.type === 'text' ? { ...block, text: cues.reduce((text, cue) => text.replace(cue, ''), block.text) } : block);
  }
  return { messages: expanded, payload: (value: unknown): unknown => {
    if (!mediaBytes) return value;
    const body = value as { messages?: { role: string; content: unknown }[] };
    if (videos.size && !Array.isArray(body.messages)) throw new Error('当前模型协议不支持原生视频');
    const result = !videos.size ? value : { ...body, messages: body.messages!.map(message => {
      if (message.role !== 'user' || !Array.isArray(message.content)) return message;
      return { ...message, content: message.content.map(block => block?.type === 'text' && videos.has(block.text) ? videos.get(block.text) : block) };
    }) };
    if (Buffer.byteLength(JSON.stringify(result)) > 15 * 1024 * 1024) throw new Error('媒体请求体过大，请减少附件');
    return result;
  } };
}

const installed = new WeakSet<AgentHarness>();
export function registerMediaHooks(harness: AgentHarness): void {
  if (installed.has(harness)) return;
  installed.add(harness);
  let transformPayload: (value: unknown) => unknown = value => value;
  harness.on('before_agent_start', ({ prompt }) => {
    const scope = mediaScope.getStore();
    if (scope?.ownerHarness === harness && scope.pending) scope.pendingPrompt = prompt;
    return undefined;
  });
  harness.on('context', async ({ messages }) => {
    const scope = mediaScope.getStore();
    if (scope?.ownerHarness === harness && scope.pending && scope.pendingPrompt !== undefined) {
      const user = [...messages].reverse().find(message => message.role === 'user' && mediaUserText(message) === scope.pendingPrompt);
      if (user) {
        const pending = scope.pending;
        const bound: MediaMessage = { ...pending, details: { ...pending.details!, owner: { timestamp: user.timestamp, text: mediaUserText(user) } } };
        // Append a versioned binding fact using the existing session channel.
        // The record ID makes replay idempotent despite delayed Harness writes.
        await harness.appendMessage(bound);
        scope.messages = scope.messages.map(message => message === pending ? bound : message);
        scope.pending = undefined;
      }
    }
    const encoded = await encodeMediaMessages(messages, harness.getModel(), scope, scope?.ownerHarness === harness);
    transformPayload = encoded.payload;
    return { messages: encoded.messages };
  });
  harness.on('before_provider_payload', ({ payload }) => ({ payload: transformPayload(payload) }));
}

export async function encodeAuditMedia(messages: Message[], model: Model<any>) {
  // Only the owning Harness can establish queue consumption. Audit prompts may
  // quote queued text, but quoting it does not admit that input into the turn.
  const encoded = await encodeMediaMessages(messages, model, mediaScope.getStore(), false);
  return { ...encoded, messages: encoded.messages as Message[] };
}
