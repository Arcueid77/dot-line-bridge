import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import {MAX_MEDIA_BYTES} from '@dot-bridge/core/channels/media.js';
import {validateLineMedia} from './media-format.js';
import {createMediaPublisher} from './media-publishing.js';

const ORIGIN = 'https://api.line.me';
const MAX_BODY = 1024 * 1024;
const bounded = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const fail = () => new Error('LINE provider request failed.');

function safeMediaName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.split(/[\\/]/u).pop().replace(/[\x00-\x1f\x7f]/gu, '_').slice(0, 255).toWellFormed();
  return name && !['.', '..'].includes(name) ? name : 'attachment';
}

function splitText(text) {
  const messages = [];
  let part = '';
  for (const character of text) {
    if (part.length + character.length > 5000) { messages.push({type: 'text', text: part}); part = ''; }
    part += character;
  }
  if (part) messages.push({type: 'text', text: part});
  return messages;
}

function normalize(event, credentials, receivedAt) {
  if (event?.type !== 'message' || event.mode !== 'active' || event.source?.type !== 'user' ||
      event.source.userId !== credentials.ownerId || event.source.groupId || event.source.roomId ||
      !bounded(event.webhookEventId) || !bounded(event.message?.id) || !bounded(event.replyToken, 1024) ||
      !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0) return null;
  let text = '';
  const attachments = [];
  const mediaRefs = [];
  const type = event.message.type;
  if (type === 'text') {
    if (typeof event.message.text !== 'string' || event.message.text.length > 20000 || !event.message.text.trim()) return null;
    text = event.message.text;
  } else if (['image', 'audio', 'video', 'file', 'sticker', 'location'].includes(type)) {
    const attachment = {kind: type === 'sticker' ? 'image' : type === 'location' ? 'file' : type};
    if (bounded(event.message.fileName, 256)) attachment.name = safeMediaName(event.message.fileName);
    attachments.push(attachment);
    // External URLs are not LINE's content API and must never receive our token.
    const native = ['image', 'audio'].includes(type) && event.message.contentProvider?.type === 'line';
    const file = type === 'file' && (!event.message.contentProvider || event.message.contentProvider.type === 'line');
    const ref = native || file ? {messageId: event.message.id, kind: type} : null;
    if (ref && Number.isSafeInteger(event.message.fileSize) && event.message.fileSize >= 0) ref.size = event.message.fileSize;
    mediaRefs.push(ref);
  } else return null;
  // A token is single use. Redelivery cannot extend the original 20 minute limit.
  const replyDeadline = Math.min(receivedAt + 55000,
    event.timestamp + (event.deliveryContext?.isRedelivery === true ? 20 * 60000 : 55000));
  return {
    id: event.webhookEventId, senderId: event.source.userId,
    conversationId: event.source.userId, text, timestamp: event.timestamp, replyDeadline,
    replyContext: {replyToken: event.replyToken, botUserId: credentials.botUserId, mediaRefs}, attachments,
  };
}

export function createProvider({credentials, onMessage, signal, fetch = globalThis.fetch, mediaPublisher}) {
  if (!credentials || !bounded(credentials.ownerId) || credentials.ownerId !== credentials.conversationId ||
      !bounded(credentials.botUserId) || credentials.botUserId === credentials.ownerId ||
      !bounded(credentials.channelSecret, 8192) || !bounded(credentials.channelAccessToken, 8192)) {
    throw new Error('LINE credentials require a private owner binding, botUserId, channelSecret and channelAccessToken.');
  }
  if (typeof onMessage !== 'function') throw new Error('LINE runtime dependencies are unavailable.');
  const publisher = mediaPublisher ?? createMediaPublisher(credentials.mediaPublishing);
  if (publisher && (typeof publisher.publish !== 'function' || typeof publisher.close !== 'function')) throw new Error('LINE media publisher is invalid.');
  const controller = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending = new Set();
  let started = false;
  let connected = false;
  let webhookReceived = false;

  function authorizeReply(message, authorize) {
    if (!started || lifetime.aborted || !message || message.senderId !== credentials.ownerId ||
        message.conversationId !== credentials.conversationId || message.replyContext?.botUserId !== credentials.botUserId ||
        !bounded(message.replyContext?.replyToken, 1024) || !Number.isSafeInteger(message.replyDeadline) ||
        message.replyDeadline <= Date.now()) throw new Error('LINE reply is unavailable or its single-use token has expired.');
    if (authorize !== undefined) {
      if (typeof authorize !== 'function') throw new Error('LINE send authorization is unavailable.');
      const result = authorize();
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new Error('LINE send authorization must be synchronous.');
      }
    }
  }

  async function request(path, body, headers = {}) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15000);
    try {
      const response = await fetch(`${ORIGIN}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: {Authorization: `Bearer ${credentials.channelAccessToken}`, ...(body ? {'Content-Type': 'application/json'} : {}), ...headers},
        ...(body ? {body: JSON.stringify(body)} : {}),
        signal: AbortSignal.any([lifetime, timeout.signal]),
      });
      if (!response.ok) throw fail();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength;
        if (size > MAX_BODY) throw fail();
        chunks.push(Buffer.from(chunk));
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail();
      return value;
    } catch { throw fail(); } finally { clearTimeout(timer); }
  }

  async function processWebhook({headers, body}) {
    if (!started || lifetime.aborted) return {status: 503, body: ''};
    if (!Buffer.isBuffer(body) || body.length > MAX_BODY) return {status: 413, body: ''};
    const signature = headers?.['x-line-signature'];
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(signature)) return {status: 401, body: ''};
    const expected = createHmac('sha256', credentials.channelSecret).update(body).digest();
    const supplied = Buffer.from(signature, 'base64');
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) return {status: 401, body: ''};
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); } catch { return {status: 400, body: ''}; }
    if (payload?.destination !== credentials.botUserId || !Array.isArray(payload.events) || payload.events.length > 1000) return {status: 400, body: ''};
    const receivedAt = Date.now();
    try {
      for (const event of payload.events) {
        if (lifetime.aborted) return {status: 503, body: ''};
        const message = normalize(event, credentials, receivedAt);
        if (message) await onMessage(message);
      }
      webhookReceived = true;
      return {status: 200, body: ''};
    } catch { return {status: 503, body: ''}; }
  }

  async function content(ref) {
    try {
      const response = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(ref.messageId)}/content`, {
        method: 'GET', redirect: 'error', credentials: 'omit',
        headers: {Authorization: `Bearer ${credentials.channelAccessToken}`},
        signal: AbortSignal.any([lifetime, AbortSignal.timeout(15000)]),
      });
      if (response.status !== 200 || Number(response.headers.get('content-length')) > MAX_MEDIA_BYTES) {
        await response.body?.cancel();
        throw fail();
      }
      const mimeType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mimeType) ||
          (ref.kind === 'image' && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) ||
          (ref.kind === 'audio' && !mimeType.startsWith('audio/'))) {
        await response.body?.cancel();
        throw fail();
      }
      const chunks = [];
      let size = 0;
      try {
        for await (const chunk of response.body ?? []) {
          size += chunk.byteLength;
          if (size > MAX_MEDIA_BYTES) throw fail();
          chunks.push(Buffer.from(chunk));
        }
        if (!size) throw fail();
        return {data: Buffer.concat(chunks), mimeType};
      } finally { for (const chunk of chunks) chunk.fill(0); }
    } catch { throw new Error('LINE attachment is unavailable; it may still be processing or have expired.'); }
  }

  return {
    async start() {
      if (lifetime.aborted) throw new Error('LINE provider is stopped.');
      if (started) return;
      const work = request('/v2/bot/info');
      pending.add(work);
      let bot;
      try { bot = await work; } finally { pending.delete(work); }
      if (bot.userId !== credentials.botUserId || lifetime.aborted) throw new Error('LINE bot identity does not match configuration.');
      connected = true;
      started = true;
    },
    async stop() {
      controller.abort();
      started = false;
      connected = false;
      await Promise.allSettled([...pending]);
      publisher?.close();
    },
    status() { return {connected: connected && !lifetime.aborted, webhookReceived,
      mediaPublisherConfigured: !!publisher, mediaPublisherRequired: true}; },
    validateMediaReply(input) {
      if (!publisher) throw new Error('LINE media hosting must be explicitly configured and approved before replying with media.');
      validateLineMedia(input);
    },
    async sendMediaReply({message, media, text, idempotencyKey, authorize}) {
      if (!publisher) throw new Error('LINE media hosting must be explicitly configured and approved before replying with media.');
      validateLineMedia({media, text});
      authorizeReply(message, authorize);
      if (!bounded(message.id) || !bounded(idempotencyKey, 128)) throw new Error('LINE media reply is unavailable.');
      const work = (async () => {
        try {
          const mediaMessage = await publisher.publish({media, text,
            objectKey: JSON.stringify([message.id, idempotencyKey]),
            authorize: () => authorizeReply(message, authorize),
            signal: AbortSignal.any([lifetime, AbortSignal.timeout(Math.max(1, Math.min(35000, message.replyDeadline - Date.now() - 2000)))])});
          authorizeReply(message, authorize);
          const messages = text ? [{type: 'text', text}, mediaMessage] : [mediaMessage];
          const result = await request('/v2/bot/message/reply', {replyToken: message.replyContext.replyToken, messages});
          const id = result.sentMessages?.[0]?.id;
          return bounded(id) ? {providerMessageId: id} : {};
        } catch { throw new Error('LINE media reply failed or its result is uncertain. Do not resend automatically.'); }
      })();
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
    async readAttachment({message, attachmentIndex}) {
      const ref = message?.replyContext?.mediaRefs?.[attachmentIndex];
      const attachment = message?.attachments?.[attachmentIndex];
      if (!started || lifetime.aborted || message?.senderId !== credentials.ownerId ||
          message.conversationId !== credentials.conversationId || message.replyContext?.botUserId !== credentials.botUserId ||
          !Number.isInteger(attachmentIndex) || attachmentIndex < 0 || attachmentIndex >= 10 ||
          !ref || typeof ref.messageId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(ref.messageId) ||
          ref.kind !== attachment?.kind || !['image', 'audio', 'file'].includes(ref.kind) ||
          (ref.size !== undefined && (!Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > MAX_MEDIA_BYTES))) {
        throw new Error('LINE attachment is unavailable.');
      }
      const work = content(ref);
      pending.add(work);
      try { return {...await work, ...(attachment.name ? {name: safeMediaName(attachment.name)} : {})}; }
      finally { pending.delete(work); }
    },
    async handleWebhook(input) {
      const work = processWebhook(input);
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
    async sendOwnerMessage({text, idempotencyKey, authorize}) {
      if (!started || lifetime.aborted || typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > 2000) throw fail();
      authorize();
      const digest=createHash('sha256').update(idempotencyKey).digest('hex');
      const retryKey=`${digest.slice(0,8)}-${digest.slice(8,12)}-${digest.slice(12,16)}-${digest.slice(16,20)}-${digest.slice(20,32)}`;
      await request('/v2/bot/message/push', {to:credentials.ownerId, messages:[{type:'text', text}]}, {'X-Line-Retry-Key':retryKey});
      return {};
    },
    async sendReply({message, text, authorize}) {
      authorizeReply(message, authorize);
      if (typeof text !== 'string' || !text.trim() || !text.isWellFormed() || text.length > 20000 || Buffer.byteLength(text) > 60000) {
        throw new Error('LINE reply is unavailable or its single-use token has expired.');
      }
      const work = request('/v2/bot/message/reply', {replyToken: message.replyContext.replyToken, messages: splitText(text)});
      pending.add(work);
      try {
        const response = await work;
        const id = response.sentMessages?.[0]?.id;
        return bounded(id) ? {providerMessageId: id} : {};
      } finally { pending.delete(work); }
    },
  };
}
