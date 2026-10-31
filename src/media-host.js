import {createHash, createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import {MAX_MEDIA_BYTES} from '@dot-bridge/core/channels/media.js';
import {validateLineMedia} from './media-format.js';
import {MEDIA_CHUNK_BYTES, MEDIA_SIGNATURE_ID, MEDIA_TTL_MS, mediaPublishingPolicy} from './media-publishing.js';

const MAX_MEMORY = 20 * 1024 * 1024;
const MAX_OBJECTS = 8;
const UPLOAD_TTL = 60000;
const SIGNATURE_AGE = 30000;
const json = (status, value) => ({status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'},
  body: Buffer.from(JSON.stringify(value))});
const empty = status => ({status, headers: {'Cache-Control': 'no-store'}, body: Buffer.alloc(0)});
const keysAre = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));

// No disk storage, account credentials, provider IDs, listing endpoint or logger.
// The operator must separately approve HTTPS publication and a dedicated key.
export function createMediaHost({policy: input, key, now = Date.now}) {
  const policy = mediaPublishingPolicy(input);
  const signingKey = Buffer.from(key ?? []);
  if (signingKey.length < 24 || signingKey.length > 64) throw new Error('A dedicated media publishing key is required.');
  const objects = new Map();
  let closed = false;
  function drop(id) { const item = objects.get(id); item?.data.fill(0); objects.delete(id); }
  function sweep() {
    for (const [id, item] of objects) if (item.expiresAt <= now()) drop(id);
  }
  const timer = setInterval(sweep, 1000);
  timer.unref();
  function authentic(headers, body) {
    if (!Buffer.isBuffer(body) || !body.length || body.length > 262144 ||
        headers?.['content-type'] !== 'application/json' || headers?.origin !== undefined ||
        headers?.['x-mcp-subscription-id'] !== MEDIA_SIGNATURE_ID) return false;
    const id = headers['webhook-id'], timestamp = headers['webhook-timestamp'], signature = headers['webhook-signature'];
    if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(id) ||
        typeof timestamp !== 'string' || !/^[0-9]{1,12}$/u.test(timestamp) ||
        typeof signature !== 'string' || !/^v1,[A-Za-z0-9+/]{43}=$/u.test(signature)) return false;
    const issued = Number(timestamp) * 1000;
    if (issued > now() + 5000 || issued < now() - SIGNATURE_AGE) return false;
    const expected = createHmac('sha256', signingKey).update(id + '.' + timestamp + '.').update(body).digest();
    const provided = Buffer.from(signature.slice(3), 'base64');
    return provided.length === expected.length && timingSafeEqual(expected, provided);
  }
  function commitResult(item) {
    const url = new URL(policy.publicBaseUrl);
    url.pathname += item.id + '.' + item.extension;
    url.searchParams.set('token', item.token);
    return {original_url: url.href, preview_url: item.kind === 'image' ? url.href : null,
      duration: item.duration, expires_at: item.expiresAt};
  }
  function upload(body) {
    let value;
    try { value = JSON.parse(body.toString('utf8')); } catch { return empty(400); }
    if (!value || !/^[a-f0-9]{64}$/u.test(value.object_id ?? '')) return empty(400);
    const id = value.object_id;
    let item = objects.get(id);
    if (value.operation === 'begin') {
      if (!keysAre(value, ['object_id', 'operation', 'kind', 'mime_type', 'size', 'sha256', 'duration']) ||
          !['image', 'audio'].includes(value.kind) ||
          !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_MEDIA_BYTES ||
          !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '') ||
          !(value.kind === 'image' ? ['image/png', 'image/jpeg'].includes(value.mime_type) && value.duration === null && value.size <= 1024 * 1024
            : value.mime_type === 'audio/mp4' && Number.isSafeInteger(value.duration) && value.duration > 0 && value.duration <= 60000)) return empty(400);
      if (item) {
        if (item.kind !== value.kind || item.mimeType !== value.mime_type || item.size !== value.size ||
            item.digest !== value.sha256 || item.duration !== value.duration) return empty(409);
        return json(200, {received: item.received});
      }
      const allocated = [...objects.values()].reduce((total, object) => total + object.data.length, 0);
      if (objects.size >= MAX_OBJECTS || allocated + value.size > MAX_MEMORY) return empty(503);
      item = {id, kind: value.kind, mimeType: value.mime_type, size: value.size, digest: value.sha256,
        duration: value.duration, data: Buffer.alloc(value.size), received: 0, ready: false, expiresAt: now() + UPLOAD_TTL};
      objects.set(id, item);
      return json(200, {received: 0});
    }
    if (!item) return empty(404);
    if (value.operation === 'append') {
      if (!keysAre(value, ['object_id', 'operation', 'offset', 'data']) ||
          !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > item.received ||
          typeof value.data !== 'string' || !value.data || value.data.length > Math.ceil(MEDIA_CHUNK_BYTES / 3) * 4 ||
          value.data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.data)) return empty(400);
      const chunk = Buffer.from(value.data, 'base64');
      try {
        if (chunk.toString('base64') !== value.data || !chunk.length || chunk.length > MEDIA_CHUNK_BYTES ||
            value.offset + chunk.length > item.size) return empty(400);
        if (value.offset < item.received || item.ready) {
          if (value.offset + chunk.length > item.received || !item.data.subarray(value.offset, value.offset + chunk.length).equals(chunk)) return empty(409);
        } else { chunk.copy(item.data, value.offset); item.received += chunk.length; }
        return json(200, {received: item.received});
      } finally { chunk.fill(0); }
    }
    if (value.operation === 'commit') {
      if (!keysAre(value, ['object_id', 'operation'])) return empty(400);
      if (!item.ready) {
        if (item.received !== item.size || createHash('sha256').update(item.data).digest('hex') !== item.digest) return empty(409);
        let format;
        try { format = validateLineMedia({media: {type: item.kind, data: item.data, mimeType: item.mimeType}}); } catch { drop(id); return empty(400); }
        if ((format.duration ?? null) !== item.duration) { drop(id); return empty(400); }
        item.extension = format.extension;
        item.token = randomBytes(32).toString('base64url');
        item.ready = true;
        item.expiresAt = now() + MEDIA_TTL_MS;
      }
      return json(200, commitResult(item));
    }
    return empty(400);
  }
  return {
    handle({method, url, headers = {}, body}) {
      if (closed) return empty(503);
      sweep();
      if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.length > 2048 || /[\x00-\x20\\#]/u.test(url)) return empty(400);
      if (method === 'POST' && url === policy.endpointPath) return authentic(headers, body) ? upload(body) : empty(401);
      if (!['GET', 'HEAD'].includes(method)) return empty(405);
      if (url === policy.endpointPath + '/healthz') return json(200, {ready: true});
      const parsed = new URL(url, 'http://127.0.0.1');
      if (parsed.pathname !== url.split('?')[0]) return empty(404);
      const objectPath = parsed.pathname.slice(policy.publicPath.length);
      if (!parsed.pathname.startsWith(policy.publicPath) || !/^[a-f0-9]{64}\.(?:png|jpg|m4a)$/u.test(objectPath) ||
          [...parsed.searchParams.keys()].join(',') !== 'token') return empty(404);
      const item = objects.get(objectPath.slice(0, 64));
      const token = parsed.searchParams.get('token');
      if (!item?.ready || objectPath !== item.id + '.' + item.extension || !/^[A-Za-z0-9_-]{43}$/u.test(token ?? '')) return empty(404);
      const supplied = Buffer.from(token), expected = Buffer.from(item.token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return empty(404);
      let start = 0, end = item.size - 1;
      const responseHeaders = {'Content-Type': item.mimeType, 'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="reply.' + item.extension + '"',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Accept-Ranges': 'bytes'};
      if (headers.range !== undefined) {
        const range = typeof headers.range === 'string' && /^bytes=(\d*)-(\d*)$/u.exec(headers.range);
        if (!range || (!range[1] && !range[2])) return empty(416);
        if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(end, Number(range[2])); }
        else start = Math.max(0, item.size - Number(range[2]));
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= item.size) return empty(416);
        responseHeaders['Content-Range'] = 'bytes ' + start + '-' + end + '/' + item.size;
      }
      responseHeaders['Content-Length'] = String(end - start + 1);
      return {status: headers.range === undefined ? 200 : 206, headers: responseHeaders,
        body: method === 'HEAD' ? Buffer.alloc(0) : Buffer.from(item.data.subarray(start, end + 1))};
    },
    sweep,
    close() { closed = true; clearInterval(timer); for (const id of objects.keys()) drop(id); signingKey.fill(0); },
  };
}
