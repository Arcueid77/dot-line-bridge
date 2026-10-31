import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createMediaHost} from '../src/media-host.js';
import {createMediaPublisher, MEDIA_TTL_MS, MEDIA_SIGNATURE_ID, mediaPublishingPolicy} from '../src/media-publishing.js';
import {validateLineMedia} from '../src/media-format.js';
import {signedHeaders} from '@dot-bridge/core/transport/transport.js';
import {createProvider} from '../src/provider.js';
import {spawnSync} from 'node:child_process';

const key = Buffer.alloc(32, 17);
const policy = {enabled: true, endpoint: 'https://media.example.test/line-publish', publicBaseUrl: 'https://media.example.test/line-media/'};
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
function box(type, bytes) { const out = Buffer.alloc(8 + bytes.length); out.writeUInt32BE(out.length); out.write(type, 4); bytes.copy(out, 8); return out; }
function m4a(milliseconds = 100) {
  const header = Buffer.alloc(20); header.writeUInt32BE(1000, 12); header.writeUInt32BE(milliseconds, 16);
  const handler = Buffer.alloc(12); handler.write('soun', 8);
  return Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0M4A ')), box('moov', Buffer.concat([
    box('mvhd', header), box('trak', box('mdia', box('hdlr', handler)))])), box('mdat', Buffer.from([1, 2, 3]))]);
}
function runtime() {
  let clock = 1700000000000;
  const host = createMediaHost({policy, key, now: () => clock});
  const calls = [];
  const publisher = createMediaPublisher(policy, {key, now: () => clock, send: async (url, options) => {
    options.beforeConnect();
    calls.push(JSON.parse(options.body).operation);
    return host.handle({method: 'POST', url: new URL(url).pathname, headers: options.headers, body: options.body});
  }});
  return {host, publisher, calls, now: () => clock, advance: ms => { clock += ms; }};
}
function signed(host, now, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value));
  const headers = signedHeaders({id: MEDIA_SIGNATURE_ID, key}, 'fixture-event', body, now());
  return host.handle({method: 'POST', url: '/line-publish', body, headers: {...headers, ...extra}});
}

test('signed chunk publication produces short-lived image/audio URLs used only inside one LINE reply', async () => {
  for (const media of [{type: 'image', mimeType: 'image/png', data: png}, {type: 'audio', mimeType: 'audio/mp4', data: m4a()}]) {
    const {host, publisher, calls, advance} = runtime();
    try {
      const result = await publisher.publish({media, objectKey: 'fixture-object', authorize() {}});
      assert.equal(result.type, media.type);
      if (media.type === 'audio') assert.equal(result.duration, 100);
      else assert.equal(result.previewImageUrl, result.originalContentUrl);
      const url = new URL(result.originalContentUrl);
      const response = host.handle({method: 'GET', url: url.pathname + url.search});
      assert.equal(response.status, 200); assert.deepEqual(response.body, media.data);
      assert.equal(response.headers['Cache-Control'], 'private, no-store, max-age=0');
      const partial = host.handle({method: 'GET', url: url.pathname + url.search, headers: {range: 'bytes=0-3'}});
      assert.equal(partial.status, 206); assert.deepEqual(partial.body, media.data.subarray(0, 4));
      assert.equal(host.handle({method: 'HEAD', url: url.pathname + url.search}).body.length, 0);
      assert.equal(host.handle({method: 'GET', url: url.pathname + '?token=' + 'a'.repeat(43)}).status, 404);
      assert.deepEqual(calls, ['begin', 'append', 'commit']);
      advance(MEDIA_TTL_MS + 1); host.sweep();
      assert.equal(host.handle({method: 'GET', url: url.pathname + url.search}).status, 404);
    } finally { publisher.close(); host.close(); }
  }
});

test('publication is explicitly configured; unrelated origins, URL credentials and unsafe paths are rejected', () => {
  assert.equal(createMediaPublisher(undefined), null);
  assert.equal(createMediaPublisher({enabled: false}), null);
  for (const change of [{enabled: false}, {endpoint: 'http://media.example.test/line-publish'},
    {endpoint: 'https://127.0.0.1/line-publish'}, {publicBaseUrl: 'https://other.example.test/media/'},
    {endpoint: 'https://user:password@media.example.test/line-publish'}, {endpoint: policy.endpoint + '?token=secret'},
    {publicBaseUrl: 'https://media.example.test/media/../private/'}, {publicBaseUrl: policy.publicBaseUrl + '?secret=private'},
    {unknown: 'not accepted'}]) assert.throws(() => mediaPublishingPolicy({...policy, ...change}));
  assert.throws(() => createMediaPublisher(policy), /unavailable/u, 'no fallback key is generated');
});

test('host checks signature, freshness and immutable ordered chunk data; replays do not extend expiry', () => {
  const {host, publisher, now, advance} = runtime();
  const id = 'a'.repeat(64);
  const begin = {object_id: id, operation: 'begin', kind: 'image', mime_type: 'image/png',
    size: png.length, sha256: createHash('sha256').update(png).digest('hex'), duration: null};
  try {
    assert.equal(host.handle({method: 'POST', url: '/line-publish', body: Buffer.from('{}'), headers: {}}).status, 401);
    assert.equal(signed(host, now, begin, {origin: 'https://attacker.test'}).status, 401);
    const staleBody = Buffer.from(JSON.stringify(begin));
    const stale = signedHeaders({id: MEDIA_SIGNATURE_ID, key}, 'old-event', staleBody, now() - 31000);
    assert.equal(host.handle({method: 'POST', url: '/line-publish', body: staleBody, headers: stale}).status, 401);
    assert.equal(signed(host, now, begin).status, 200);
    assert.equal(signed(host, now, {...begin, sha256: 'b'.repeat(64)}).status, 409);
    assert.equal(signed(host, now, {object_id: id, operation: 'append', offset: 1, data: png.toString('base64')}).status, 400);
    const append = {object_id: id, operation: 'append', offset: 0, data: png.toString('base64')};
    assert.equal(signed(host, now, append).status, 200);
    assert.equal(signed(host, now, append).status, 200);
    assert.equal(signed(host, now, {...append, data: Buffer.alloc(png.length).toString('base64')}).status, 409);
    const first = JSON.parse(signed(host, now, {object_id: id, operation: 'commit'}).body);
    advance(10000);
    const replay = JSON.parse(signed(host, now, {object_id: id, operation: 'commit'}).body);
    assert.deepEqual(replay, first);
  } finally { publisher.close(); host.close(); }
});

test('bad formats, malformed M4A, excessive duration and generic files are rejected before publication', () => {
  for (const media of [{type: 'file', mimeType: 'text/plain', data: Buffer.from('file')},
    {type: 'image', mimeType: 'image/jpeg', data: png}, {type: 'image', mimeType: 'image/png', data: Buffer.alloc(1024 * 1024 + 1)},
    {type: 'audio', mimeType: 'audio/mpeg', data: Buffer.from('ID3')},
    {type: 'audio', mimeType: 'audio/mp4', data: m4a(60001)}, {type: 'audio', mimeType: 'audio/mp4', data: Buffer.alloc(100)}]) {
    assert.throws(() => validateLineMedia({media}));
  }
  assert.throws(() => validateLineMedia({media: {type: 'image', mimeType: 'image/png', data: png}, text: 'x'.repeat(5001)}));
  const video = m4a(); video.write('vide', video.indexOf('soun'));
  assert.throws(() => validateLineMedia({media: {type: 'audio', mimeType: 'audio/mp4', data: video}}));
});

test('host caps declared allocations and expires unfinished uploads without refreshing their lifetime', () => {
  const {host, publisher, now, advance} = runtime();
  try {
    const begin = id => ({object_id: id, operation: 'begin', kind: 'audio', mime_type: 'audio/mp4',
      size: 5 * 1024 * 1024, sha256: 'a'.repeat(64), duration: 100});
    for (let index = 0; index < 4; index++) assert.equal(signed(host, now, begin(String(index).repeat(64))).status, 200);
    assert.equal(signed(host, now, begin('4'.repeat(64))).status, 503);
    advance(59000);
    assert.equal(signed(host, now, begin('0'.repeat(64))).status, 200);
    advance(1001);
    assert.equal(signed(host, now, {object_id: '0'.repeat(64), operation: 'commit'}).status, 404);
    assert.equal(signed(host, now, begin('4'.repeat(64))).status, 200);
  } finally { publisher.close(); host.close(); }
});

test('host verifies completed content hash and never exposes incomplete or wrong bytes', () => {
  const {host, publisher, now} = runtime();
  const id = 'b'.repeat(64);
  try {
    assert.equal(signed(host, now, {object_id: id, operation: 'begin', kind: 'image', mime_type: 'image/png',
      size: png.length, sha256: 'a'.repeat(64), duration: null}).status, 200);
    assert.equal(signed(host, now, {object_id: id, operation: 'commit'}).status, 409);
    assert.equal(signed(host, now, {object_id: id, operation: 'append', offset: 0, data: png.toString('base64')}).status, 200);
    assert.equal(signed(host, now, {object_id: id, operation: 'commit'}).status, 409);
    assert.equal(host.handle({method: 'GET', url: '/line-media/' + id + '.png?token=' + 'x'.repeat(43)}).status, 404);
    assert.equal(host.handle({method: 'GET', url: '/line-media/'}).status, 404);
  } finally { publisher.close(); host.close(); }
});

test('media-host entry point never reads private configuration or starts a listener without explicit approval', () => {
  const result = spawnSync(process.execPath, ['scripts/run-media-host.js'], {
    encoding: 'utf8', windowsHide: true, env: {...process.env, LINE_MEDIA_HOST_CONFIG_FILE: '/nonexistent/private/config.json'},
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No private files read/u);
  assert.equal(result.stderr, '');
});

test('LINE provider sends media and optional text in one original-token request; status and returned result have no hosting URL', async () => {
  const {host, publisher} = runtime();
  const credentials = {ownerId: 'fixture-owner', conversationId: 'fixture-owner', botUserId: 'fixture-bot',
    channelSecret: 'fixture-secret', channelAccessToken: 'fixture-token'};
  const calls = [];
  const provider = createProvider({credentials, onMessage: async () => {}, mediaPublisher: publisher, fetch: async (url, options) => {
    calls.push({url, body: options.body && JSON.parse(options.body)});
    return new Response(JSON.stringify(url.endsWith('/info') ? {userId: credentials.botUserId} : {sentMessages: [{id: 'sent-1'}]}));
  }});
  const message = {id: 'fixture-event', senderId: credentials.ownerId, conversationId: credentials.ownerId,
    replyDeadline: Date.now() + 55000, replyContext: {botUserId: credentials.botUserId, replyToken: 'fixture-reply-token'}};
  await provider.start();
  try {
    assert.equal(provider.status().mediaPublisherConfigured, true);
    const result = await provider.sendMediaReply({message, media: {type: 'image', mimeType: 'image/png', data: png},
      text: 'fixture caption', idempotencyKey: 'fixture-key', authorize() {}});
    assert.deepEqual(result, {providerMessageId: 'sent-1'});
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://api.line.me/v2/bot/message/reply');
    assert.equal(calls[1].body.replyToken, message.replyContext.replyToken);
    assert.equal(calls[1].body.to, undefined);
    assert.equal(calls[1].body.messages.length, 2);
    assert.equal(calls[1].body.messages[0].text, 'fixture caption');
    assert.equal(calls[1].body.messages[1].type, 'image');
    assert.ok(Object.values(provider.status()).every(value => typeof value === 'boolean'));
  } finally { await provider.stop(); host.close(); }
});

test('revocation during upload stops final LINE send and an uncertain send has no retry or text fallback', async () => {
  for (const stage of ['upload', 'send']) {
    let allowed = true, finalSends = 0, publishCalls = 0;
    const credentials = {ownerId: 'fixture-owner', conversationId: 'fixture-owner', botUserId: 'fixture-bot',
      channelSecret: 'fixture-secret', channelAccessToken: 'fixture-token'};
    const provider = createProvider({credentials, onMessage: async () => {}, mediaPublisher: {
      async publish({authorize}) { publishCalls++; if (stage === 'upload') allowed = false; authorize(); return {type: 'image', originalContentUrl: 'https://fixture.test/image', previewImageUrl: 'https://fixture.test/image'}; },
      close() {},
    }, fetch: async url => {
      if (url.endsWith('/info')) return new Response(JSON.stringify({userId: credentials.botUserId}));
      finalSends++; throw new Error('private provider error');
    }});
    await provider.start();
    try {
      await assert.rejects(provider.sendMediaReply({message: {id: 'fixture-event', senderId: credentials.ownerId, conversationId: credentials.ownerId,
        replyDeadline: Date.now() + 55000, replyContext: {botUserId: credentials.botUserId, replyToken: 'reply-token'}},
        media: {type: 'image', mimeType: 'image/png', data: png}, idempotencyKey: 'key',
        authorize() { if (!allowed) throw new Error('revoked'); }}), {message: 'LINE media reply failed or its result is uncertain. Do not resend automatically.'});
      assert.equal(publishCalls, 1); assert.equal(finalSends, stage === 'upload' ? 0 : 1);
    } finally { await provider.stop(); }
  }
});
