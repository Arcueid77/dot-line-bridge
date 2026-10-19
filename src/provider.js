import {createHmac, timingSafeEqual} from 'node:crypto';

const ORIGIN = 'https://api.line.me';
const MAX_BODY = 1024 * 1024;
const bounded = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const fail = () => new Error('LINE provider request failed.');

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
  const type = event.message.type;
  if (type === 'text') {
    if (typeof event.message.text !== 'string' || event.message.text.length > 20000 || !event.message.text.trim()) return null;
    text = event.message.text;
  } else if (['image', 'audio', 'video', 'file', 'sticker', 'location'].includes(type)) {
    const attachment = {kind: type === 'sticker' ? 'image' : type === 'location' ? 'file' : type};
    if (bounded(event.message.fileName, 256)) attachment.name = event.message.fileName;
    attachments.push(attachment);
  } else return null;
  // A token is single use. Redelivery cannot extend the original 20 minute limit.
  const replyDeadline = Math.min(receivedAt + 55000,
    event.timestamp + (event.deliveryContext?.isRedelivery === true ? 20 * 60000 : 55000));
  return {
    id: event.webhookEventId, senderId: event.source.userId,
    conversationId: event.source.userId, text, timestamp: event.timestamp, replyDeadline,
    replyContext: {replyToken: event.replyToken, botUserId: credentials.botUserId}, attachments,
  };
}

export function createProvider({credentials, onMessage, signal, fetch = globalThis.fetch}) {
  if (!credentials || !bounded(credentials.ownerId) || credentials.ownerId !== credentials.conversationId ||
      !bounded(credentials.botUserId) || credentials.botUserId === credentials.ownerId ||
      !bounded(credentials.channelSecret, 8192) || !bounded(credentials.channelAccessToken, 8192)) {
    throw new Error('LINE credentials require a private owner binding, botUserId, channelSecret and channelAccessToken.');
  }
  if (typeof onMessage !== 'function') throw new Error('LINE runtime dependencies are unavailable.');
  const controller = new AbortController();
  const lifetime = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending = new Set();
  let started = false;
  let connected = false;
  let webhookReceived = false;

  async function request(path, body) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15000);
    try {
      const response = await fetch(`${ORIGIN}${path}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: {Authorization: `Bearer ${credentials.channelAccessToken}`, ...(body ? {'Content-Type': 'application/json'} : {})},
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
    },
    status() { return {connected: connected && !lifetime.aborted, webhookReceived}; },
    async handleWebhook(input) {
      const work = processWebhook(input);
      pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    },
    async sendReply({message, text}) {
      if (!started || lifetime.aborted || !message || message.senderId !== credentials.ownerId ||
          message.conversationId !== credentials.conversationId || message.replyContext?.botUserId !== credentials.botUserId ||
          !bounded(message.replyContext?.replyToken, 1024) || !Number.isSafeInteger(message.replyDeadline) ||
          message.replyDeadline <= Date.now() || typeof text !== 'string' || !text.trim() || text.length > 20000) {
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
