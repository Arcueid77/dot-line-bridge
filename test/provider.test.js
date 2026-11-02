import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {createProvider} from '../src/provider.js';

const credentials = {ownerId: 'U-owner', conversationId: 'U-owner', botUserId: 'U-bot', channelSecret: 'synthetic-secret', channelAccessToken: 'synthetic-access'};
const response = value => new Response(JSON.stringify(value));
const event = overrides => ({type: 'message', mode: 'active', webhookEventId: 'event-1', timestamp: Date.now(),
  source: {type: 'user', userId: credentials.ownerId}, replyToken: 'reply-token',
  message: {id: 'message-1', type: 'text', text: 'hello\nfixture 🌏'}, ...overrides});
function signed(events, extra = {}) {
  const body = Buffer.from(JSON.stringify({destination: credentials.botUserId, events, ...extra}));
  return {body, headers: {'x-line-signature': createHmac('sha256', credentials.channelSecret).update(body).digest('base64')}};
}
function runtime(options = {}) {
  const messages = [];
  const calls = [];
  const provider = createProvider({credentials, onMessage: async message => { messages.push(message); },
    fetch: async (url, request) => { calls.push({url, request}); return response(url.endsWith('/info') ? {userId: credentials.botUserId} : {sentMessages: [{id: 'sent-1'}]}); }, ...options});
  return {provider, messages, calls};
}

test('proactive LINE text uses push to the bound owner with a stable retry key, never a consumed reply token',async t=>{
  const {provider,calls}=runtime();t.after(()=>provider.stop());await provider.start();
  await provider.sendOwnerMessage({text:'fixture notification',idempotencyKey:'fixture-occurrence',authorize:()=>{}});
  const call=calls.at(-1),body=JSON.parse(call.request.body);assert.equal(call.url,'https://api.line.me/v2/bot/message/push');assert.equal(body.to,credentials.ownerId);assert.equal(body.messages[0].text,'fixture notification');assert.equal(Object.hasOwn(body,'replyToken'),false);assert.match(call.request.headers['X-Line-Retry-Key'],/^[a-f0-9-]{36}$/);
  const before=calls.length;await assert.rejects(provider.sendOwnerMessage({text:'blocked',idempotencyKey:'other',authorize:()=>{throw Error('revoked');}}));assert.equal(calls.length,before);
});

test('startup verifies existing bot token and configured bot identity read-only', async () => {
  const {provider, calls} = runtime(); await provider.start();
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.line.me/v2/bot/info');
  assert.equal(calls[0].request.method, 'GET'); assert.equal(calls[0].request.redirect, 'error');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer synthetic-access');
  assert.deepEqual(provider.status(), {connected: true, webhookReceived: false, mediaPublisherConfigured: false, mediaPublisherRequired: true}); await provider.stop();
  const denied = runtime({fetch: async () => response({userId: 'wrong-bot'})}).provider;
  await assert.rejects(denied.start(), {message: 'LINE bot identity does not match configuration.'}); await denied.stop();
});

test('signature is verified against untouched bytes before JSON parsing', async () => {
  const {provider, messages} = runtime(); await provider.start();
  assert.equal((await provider.handleWebhook({body: Buffer.from('not-json'), headers: {}})).status, 401);
  const badJson = Buffer.from('not-json');
  assert.equal((await provider.handleWebhook({body: badJson, headers: {'x-line-signature': createHmac('sha256', credentials.channelSecret).update(badJson).digest('base64')}})).status, 400);
  const valid = signed([event()]);
  assert.equal((await provider.handleWebhook({...valid, body: Buffer.concat([valid.body, Buffer.from(' ')])})).status, 401);
  assert.equal((await provider.handleWebhook({...valid, headers: {'x-line-signature': 'a'.repeat(44)}})).status, 401);
  assert.equal(messages.length, 0);
  assert.equal((await provider.handleWebhook(valid)).status, 200); assert.equal(messages[0].text, 'hello\nfixture 🌏');
  await provider.stop();
});

test('rejects wrong destination and accepts signed LINE empty verification webhook', async () => {
  const {provider, messages} = runtime(); await provider.start();
  assert.equal((await provider.handleWebhook(signed([event()], {destination: 'wrong-bot'}))).status, 400);
  assert.equal((await provider.handleWebhook(signed([]))).status, 200);
  assert.equal(messages.length, 0); assert.equal(provider.status().webhookReceived, true); await provider.stop();
});

test('only bound private owner messages enter core; standby/system/group/other owners are ignored', async () => {
  const {provider, messages} = runtime(); await provider.start();
  const invalid = [event({source: {type: 'group', groupId: 'g', userId: credentials.ownerId}}),
    event({source: {type: 'user', userId: 'other'}}), event({source: {type: 'user', userId: credentials.ownerId, roomId: 'r'}}),
    event({mode: 'standby'}), event({type: 'follow'}), event({replyToken: ''}), event({timestamp: NaN})];
  assert.equal((await provider.handleWebhook(signed(invalid))).status, 200); assert.equal(messages.length, 0); await provider.stop();
});

test('webhook HTTP acknowledgement waits for durable ingestion and failures request redelivery', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const {provider} = runtime({onMessage: async () => { entered(); await gate; throw new Error('private fixture'); }});
  await provider.start(); let complete = false;
  const incoming = provider.handleWebhook(signed([event()])).then(value => { complete = true; return value; });
  await started; assert.equal(complete, false); release(); assert.equal((await incoming).status, 503); await provider.stop();
});

test('stable event identity and original reply token survive webhook redelivery', async () => {
  const {provider, messages} = runtime(); await provider.start();
  const original = event(); await provider.handleWebhook(signed([original]));
  await provider.handleWebhook(signed([{...original, deliveryContext: {isRedelivery: true}}]));
  assert.equal(messages[0].id, messages[1].id); assert.equal(messages[0].id, original.webhookEventId);
  assert.equal(messages[0].replyContext.replyToken, 'reply-token'); assert.equal(messages[0].conversationId, credentials.ownerId);
  assert.ok(messages[0].replyDeadline <= original.timestamp + 55000); await provider.stop();
});

test('media reports bounded metadata and never follows content URLs', async () => {
  const {provider, messages, calls} = runtime(); await provider.start();
  await provider.handleWebhook(signed([event({message: {id: 'file-1', type: 'file', fileName: 'report.pdf', originalContentUrl: 'http://127.0.0.1/private'}})]));
  assert.deepEqual(messages[0].attachments, [{kind: 'file', name: 'report.pdf'}]); assert.equal(messages[0].text, '');
  assert.equal(calls.length, 1); assert.equal(JSON.stringify(messages).includes('127.0.0.1'), false); await provider.stop();
});

test('sends one reply POST using stored token and chunks long Unicode safely in that request', async () => {
  const {provider, messages, calls} = runtime(); await provider.start(); await provider.handleWebhook(signed([event()]));
  const text = 'a'.repeat(4999) + '🌏' + 'b'.repeat(6000);
  assert.deepEqual(await provider.sendReply({message: messages[0], text, idempotencyKey: 'stable'}), {providerMessageId: 'sent-1'});
  assert.equal(calls.length, 2); const sent = calls[1];
  assert.equal(sent.url, 'https://api.line.me/v2/bot/message/reply'); assert.equal(sent.request.method, 'POST');
  const body = JSON.parse(sent.request.body); assert.equal(body.replyToken, 'reply-token'); assert.equal(body.messages.length, 3);
  assert.ok(body.messages.every(message => message.text.length <= 5000)); assert.equal(body.messages.map(message => message.text).join(''), text);
  assert.equal(body.to, undefined); assert.equal(sent.request.headers['X-Line-Retry-Key'], undefined); await provider.stop();
});

test('expired tokens/wrong owner/oversized content are refused before sending', async () => {
  const {provider, messages, calls} = runtime(); await provider.start(); await provider.handleWebhook(signed([event()]));
  await assert.rejects(provider.sendReply({message: {...messages[0], replyDeadline: Date.now() - 1}, text: 'reply'}));
  await assert.rejects(provider.sendReply({message: {...messages[0], senderId: 'other'}, text: 'reply'}));
  await assert.rejects(provider.sendReply({message: messages[0], text: 'x'.repeat(20001)}));
  assert.equal(calls.length, 1); await provider.stop();
});

test('send errors are sanitized and never retried or changed into push messages', async () => {
  let sends = 0;
  const {provider, messages} = runtime({fetch: async url => {
    if (url.endsWith('/info')) return response({userId: credentials.botUserId});
    sends++; throw new Error('private token and text');
  }});
  await provider.start(); await provider.handleWebhook(signed([event()]));
  await assert.rejects(provider.sendReply({message: messages[0], text: 'reply'}), {message: 'LINE provider request failed.'});
  assert.equal(sends, 1); await provider.stop();
});

test('stop aborts owned requests and disables webhook ingestion', async () => {
  let signal;
  const {provider} = runtime({fetch: async (url, options) => {
    signal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('fixture abort')), {once: true}));
  }});
  const starting = provider.start(); const rejected = assert.rejects(starting, {message: 'LINE provider request failed.'});
  await provider.stop(); await rejected; assert.equal(signal.aborted, true);
  assert.equal((await provider.handleWebhook(signed([event()]))).status, 503);
  assert.equal(provider.status().connected, false);
});
