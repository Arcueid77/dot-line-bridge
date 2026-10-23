import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createProvider} from '../src/provider.js';
import {channel} from '../src/channel.js';

const credentials = {ownerId: 'U-owner', conversationId: 'U-owner', botUserId: 'U-bot', channelSecret: 'fixture-secret', channelAccessToken: 'fixture-access'};
const MAX = 8 * 1024 * 1024;
function webhook(message) {
  const body = Buffer.from(JSON.stringify({destination: credentials.botUserId, events: [{type: 'message', mode: 'active',
    webhookEventId: 'fixture-event', timestamp: Date.now(), source: {type: 'user', userId: credentials.ownerId},
    replyToken: 'fixture-token', message}]}));
  return {body, headers: {'x-line-signature': createHmac('sha256', credentials.channelSecret).update(body).digest('base64')}};
}
async function fixture(message, content) {
  const messages = []; const calls = [];
  const provider = createProvider({credentials, onMessage: async value => messages.push(value), fetch: async (url, options) => {
    if (url.endsWith('/info')) return new Response(JSON.stringify({userId: credentials.botUserId}));
    calls.push({url, options}); return content(url, options);
  }});
  await provider.start();
  assert.equal((await provider.handleWebhook(webhook(message))).status, 200);
  return {provider, message: messages[0], calls};
}

test('native images, audio and files download from the authenticated LINE content endpoint', async () => {
  for (const [type, mimeType] of [['image', 'image/png'], ['audio', 'audio/mp4'], ['file', 'application/pdf']]) {
    const bytes = Buffer.from('fixture bytes');
    const {provider, message, calls} = await fixture({id: '789123', type, contentProvider: {type: 'line'},
      ...(type === 'file' ? {fileName: 'fixture.pdf', fileSize: bytes.length} : {})},
    async () => new Response(bytes, {headers: {'content-type': mimeType}}));
    try {
      assert.equal(calls.length, 0);
      assert.equal(JSON.stringify(message.attachments).includes('789123'), false);
      const result = await provider.readAttachment({message, attachmentIndex: 0});
      assert.deepEqual(result.data, bytes); assert.equal(result.mimeType, mimeType);
      assert.equal(calls[0].url, 'https://api-data.line.me/v2/bot/message/789123/content');
      assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-access'); assert.equal(calls[0].options.redirect, 'error');
    } finally { await provider.stop(); }
  }
});

test('external media, stickers and locations never trigger URL fetching', async () => {
  for (const type of ['image', 'audio', 'file', 'sticker', 'location']) {
    const {provider, message, calls} = await fixture({id: '789123', type,
      contentProvider: {type: 'external', originalContentUrl: 'http://127.0.0.1/secret'}},
    async () => assert.fail('external media must never fetch'));
    try {
      assert.equal(JSON.stringify(message).includes('127.0.0.1'), false);
      await assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), /unavailable/u);
      assert.equal(calls.length, 0);
    } finally { await provider.stop(); }
  }
});

test('file names remain safe basenames under the shared 255-character result contract', async () => {
  const {provider, message} = await fixture({id: '789123', type: 'file', fileName: 'C:\\private\\report.pdf'},
    async () => new Response('%PDF-fixture', {headers: {'content-type': 'application/pdf'}}));
  try {
    assert.equal(message.attachments[0].name, 'report.pdf');
    assert.equal((await provider.readAttachment({message, attachmentIndex: 0})).name, 'report.pdf');
    message.attachments[0].name = 'x'.repeat(254) + '🌏';
    const name = (await provider.readAttachment({message, attachmentIndex: 0})).name;
    assert.equal(name.length, 255); assert.equal(/\p{Surrogate}/u.test(name), false);
  } finally { await provider.stop(); }
});

test('readers revalidate stored owner/bot binding, indices, metadata kind and content IDs', async () => {
  const {provider, message, calls} = await fixture({id: '789123', type: 'image', contentProvider: {type: 'line'}}, async () => assert.fail('invalid request fetched'));
  try {
    for (const changed of [{...message, senderId: 'other'}, {...message, conversationId: 'other'},
      {...message, replyContext: {...message.replyContext, botUserId: 'other'}}, {...message, attachments: [{kind: 'file'}]}]) {
      await assert.rejects(provider.readAttachment({message: changed, attachmentIndex: 0}));
    }
    for (const messageId of ['..', '../info', '%2e%2e', 'https://attacker.test/secret', 'x/y', '']) {
      const changed = {...message, replyContext: {...message.replyContext, mediaRefs: [{kind: 'image', messageId}]}};
      await assert.rejects(provider.readAttachment({message: changed, attachmentIndex: 0}));
    }
    for (const attachmentIndex of [-1, '0', 0.5, 1, 10]) await assert.rejects(provider.readAttachment({message, attachmentIndex}));
    assert.equal(calls.length, 0);
  } finally { await provider.stop(); }
});

test('known size, response header and streamed size limits prevent large attachment reads', async () => {
  for (const [fileSize, answer] of [[MAX + 1, null], [1, () => new Response('a', {headers: {'content-type': 'application/pdf', 'content-length': String(MAX + 1)}})],
    [undefined, () => new Response(Buffer.alloc(MAX + 1), {headers: {'content-type': 'application/pdf'}})]]) {
    const {provider, message, calls} = await fixture({id: '789123', type: 'file', fileName: 'fixture.pdf', fileSize},
      async () => answer ? answer() : assert.fail('oversize declared in webhook'));
    try {
      await assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), /unavailable/u);
      if (fileSize > MAX) assert.equal(calls.length, 0);
    } finally { await provider.stop(); }
  }
});

test('202 preparation, expired content, redirects and mismatched MIME never become successful bytes', async () => {
  for (const answer of [() => new Response('', {status: 202}), () => new Response('private', {status: 410}),
    () => new Response('', {status: 302, headers: {location: 'https://attacker.test/secret'}}),
    () => new Response('private', {headers: {'content-type': 'text/html'}})]) {
    const {provider, message, calls} = await fixture({id: '789123', type: 'audio', contentProvider: {type: 'line'}}, async () => answer());
    try {
      await assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), {message: 'LINE attachment is unavailable; it may still be processing or have expired.'});
      assert.equal(calls.length, 1);
    } finally { await provider.stop(); }
  }
});

test('shutdown cancels owned reads and returns only sanitized provider failures', async () => {
  let signal;
  const {provider, message} = await fixture({id: '789123', type: 'file'}, async (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('private bearer and URL')), {once: true}));
  });
  const reading = assert.rejects(provider.readAttachment({message, attachmentIndex: 0}), {message: 'LINE attachment is unavailable; it may still be processing or have expired.'});
  await provider.stop(); await reading; assert.equal(signal.aborted, true);
});

test('media reply capability remains absent without an operator-approved public media service', () => {
  assert.deepEqual(channel.media, {read: ['image', 'audio', 'file'], reply: []});
  const provider = createProvider({credentials, onMessage: async () => {}});
  assert.equal(provider.sendMediaReply, undefined);
});
