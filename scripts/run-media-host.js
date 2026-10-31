import http from 'node:http';
import path from 'node:path';
import {readPrivateFile} from '@dot-bridge/core/platform/private-files.js';
import {createMediaHost} from '../src/media-host.js';
import {readPublishingKey} from '../src/media-publishing.js';

if (process.argv.length !== 3 || process.argv[2] !== '--confirm-public-media-host') {
  process.stdout.write('Media hosting requires explicit --confirm-public-media-host approval. No private files read.\n');
} else {
  let raw, key, host;
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major !== 24 || minor < 15) throw Error();
    const file = process.env.LINE_MEDIA_HOST_CONFIG_FILE;
    if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file) throw Error();
    raw = readPrivateFile(file, {maxBytes: 16384});
    const config = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(raw));
    if (!config || Array.isArray(config) || Object.keys(config).some(name => !['enabled', 'endpoint', 'publicBaseUrl', 'signingKeyFile', 'port'].includes(name)) ||
        !Number.isSafeInteger(config.port) || config.port < 1024 || config.port > 65535) throw Error();
    key = readPublishingKey(config.signingKeyFile);
    const {port, ...policy} = config;
    host = createMediaHost({policy, key});
    key.fill(0); raw.fill(0);
    const server = http.createServer({maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 5000}, async (request, response) => {
      if (request.headers.host !== '127.0.0.1:' + port || request.headers.origin !== undefined ||
          request.headers['transfer-encoding'] !== undefined && request.headers['content-length'] !== undefined) {
        response.writeHead(400, {Connection: 'close'}).end(); return;
      }
      let body;
      const chunks = [];
      try {
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 262144) { response.writeHead(413, {Connection: 'close'}).end(); return; }
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks);
        const result = host.handle({method: request.method, url: request.url, headers: request.headers, body});
        // handle() returns a response-owned copy, never the retained object.
        // Wait for the write to finish (or close) before clearing that copy.
        const clearResponse = () => {
          result.body.fill(0);
          response.removeListener('finish', clearResponse);
          response.removeListener('close', clearResponse);
        };
        response.once('finish', clearResponse); response.once('close', clearResponse);
        response.writeHead(result.status, {...result.headers, Connection: 'close'});
        response.end(result.body);
      } catch {
        if (!response.headersSent) response.writeHead(500, {Connection: 'close'});
        response.end();
      } finally { body?.fill(0); for (const chunk of chunks) chunk.fill(0); }
    });
    server.maxConnections = 16;
    server.maxHeadersCount = 24;
    server.keepAliveTimeout = 1000;
    server.on('error', () => { host.close(); process.stderr.write('LINE media host failed to start.\n'); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => process.stdout.write('LINE media host is listening on loopback. HTTPS publication is operator-managed.\n'));
    const stop = () => {
      host.close();
      const timer = setTimeout(() => server.closeAllConnections(), 45000); timer.unref();
      server.close(() => clearTimeout(timer));
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } catch {
    host?.close(); process.stderr.write('LINE media hosting requires valid protected configuration and a dedicated publishing key.\n');
    process.exitCode = 1;
  } finally { raw?.fill(0); key?.fill(0); }
}
