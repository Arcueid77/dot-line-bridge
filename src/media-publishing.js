import {createHash} from 'node:crypto';
import path from 'node:path';
import {readPrivateFile} from '@dot-bridge/core/platform/private-files.js';
import {decodeWebhookKey, makeCallbackTransport, signedHeaders, validateCallbackUrl} from '@dot-bridge/core/transport/transport.js';
import {validateLineMedia} from './media-format.js';

export const MEDIA_CHUNK_BYTES = 128 * 1024;
export const MEDIA_TTL_MS = 120000;
export const MEDIA_SIGNATURE_ID = 'line-media-v1';
const unavailable = () => new Error('LINE media hosting is unavailable. Configure and explicitly enable an approved media publisher.');

export function mediaPublishingPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.enabled !== true ||
      Object.keys(value).some(key => !['enabled', 'endpoint', 'publicBaseUrl', 'signingKeyFile'].includes(key))) throw unavailable();
  let endpoint, publicBase;
  try { endpoint = validateCallbackUrl(value.endpoint); publicBase = validateCallbackUrl(value.publicBaseUrl); } catch { throw unavailable(); }
  if (endpoint.href !== value.endpoint || publicBase.href !== value.publicBaseUrl ||
      endpoint.origin !== publicBase.origin || endpoint.search || publicBase.search ||
      !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(endpoint.pathname) ||
      !/^\/(?:[A-Za-z0-9_-]+\/)+$/u.test(publicBase.pathname) ||
      endpoint.pathname.startsWith(publicBase.pathname)) throw unavailable();
  return Object.freeze({endpoint: endpoint.href, publicBaseUrl: publicBase.href, hostname: endpoint.hostname,
    endpointPath: endpoint.pathname, publicPath: publicBase.pathname});
}

export function readPublishingKey(file) {
  let raw;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw unavailable();
    raw = readPrivateFile(file, {maxBytes: 128});
    return decodeWebhookKey(new TextDecoder('utf-8', {fatal: true}).decode(raw).trim());
  } catch { throw unavailable(); } finally { raw?.fill(0); }
}

export function createMediaPublisher(value, {send, key: testKey, now = Date.now} = {}) {
  if (value === undefined || value?.enabled === false) return null;
  const policy = mediaPublishingPolicy(value);
  const key = testKey ? Buffer.from(testKey) : readPublishingKey(value.signingKeyFile);
  if (key.length < 24 || key.length > 64) { key.fill(0); throw unavailable(); }
  const transport = send ?? makeCallbackTransport({timeoutMs: 10000, maxBytes: 16384, maxRequestBytes: 262144});
  let closed = false;
  const gate = authorize => {
    if (closed || typeof authorize !== 'function') throw unavailable();
    const result = authorize();
    if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); throw unavailable(); }
  };
  async function command(objectId, body, authorize, signal) {
    gate(authorize);
    const bytes = Buffer.from(JSON.stringify(body));
    const eventId = 'line-media.' + objectId + '.' + body.operation + '.' + (body.offset ?? 0);
    try {
      const result = await transport(policy.endpoint, {headers: signedHeaders({id: MEDIA_SIGNATURE_ID, key}, eventId, bytes, now()),
        body: bytes, hosts: [policy.hostname], beforeConnect: () => gate(authorize), signal});
      if (result.status !== 200 || !Buffer.isBuffer(result.body) || result.body.length > 16384) throw unavailable();
      try { return JSON.parse(result.body.toString('utf8')); } finally { result.body.fill(0); }
    } catch { throw unavailable(); } finally { bytes.fill(0); }
  }
  return {
    async publish({media, text, objectKey, authorize, signal}) {
      const format = validateLineMedia({media, text});
      if (typeof objectKey !== 'string' || !objectKey || objectKey.length > 2048) throw unavailable();
      const objectId = createHash('sha256').update(objectKey).digest('hex');
      const digest = createHash('sha256').update(media.data).digest('hex');
      const common = {object_id: objectId};
      await command(objectId, {...common, operation: 'begin', kind: media.type, mime_type: media.mimeType,
        size: media.data.length, sha256: digest, duration: format.duration ?? null}, authorize, signal);
      for (let offset = 0; offset < media.data.length; offset += MEDIA_CHUNK_BYTES) {
        await command(objectId, {...common, operation: 'append', offset,
          data: media.data.subarray(offset, offset + MEDIA_CHUNK_BYTES).toString('base64')}, authorize, signal);
      }
      const result = await command(objectId, {...common, operation: 'commit'}, authorize, signal);
      const expectedPath = policy.publicPath + objectId + '.' + format.extension;
      const validUrl = raw => {
        let url; try { url = validateCallbackUrl(raw); } catch { throw unavailable(); }
        if (url.origin !== new URL(policy.publicBaseUrl).origin || url.pathname !== expectedPath ||
            [...url.searchParams.keys()].join(',') !== 'token' || !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get('token') ?? '')) throw unavailable();
        return url.href;
      };
      if (!Number.isSafeInteger(result.expires_at) || result.expires_at <= now() + 15000 ||
          result.expires_at > now() + MEDIA_TTL_MS || result.duration !== (format.duration ?? null)) throw unavailable();
      const original = validUrl(result.original_url);
      if (media.type === 'image') return {type: 'image', originalContentUrl: original, previewImageUrl: validUrl(result.preview_url)};
      return {type: 'audio', originalContentUrl: original, duration: format.duration};
    },
    close() { closed = true; key.fill(0); },
  };
}
