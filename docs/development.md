# Provider implementation

`src/provider.js` implements LINE Messaging API; core owns encrypted state, final-reply deduplication, MCP, callback policy and lifecycle. Core's separate live-only loopback listener exposes `POST /webhook` on port 8895 by default; MCP remains on 8795.

Primary sources reviewed on 2026-10-23:

- [Webhook signature verification](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- [Receiving messages and webhook redelivery](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)
- [Messaging API reference](https://developers.line.biz/en/reference/messaging-api/#send-reply-message)
- [Official SDK reply request shape](https://github.com/line/line-bot-sdk-nodejs/blob/master/lib/messaging-api/model/replyMessageRequest.ts)
- [Get user-sent binary content](https://developers.line.biz/en/reference/messaging-api/#get-content)
- [Reply media requirements and supported message objects](https://developers.line.biz/en/reference/messaging-api/#message-objects)

The provider independently verifies HMAC-SHA256 over the original bounded Buffer using constant-time digest comparison. It parses only authenticated payloads, checks the exact configured bot destination and accepts only active private messages from the configured owner. No group, follow, standby or unrelated-owner event is sent to core. Signed empty validation webhooks are supported. `webhookEventId` provides the stable deduplication key; the reply token remains private encrypted reply context.

HTTP success is returned only after all normalized messages have passed awaited durable ingestion. Exceptions return 503 for optional platform redelivery. Core handles duplicate accepted events without sending a second final reply. Token expiry is conservative: 55 seconds after webhook receipt, bounded by event timestamp plus 55 seconds for initial delivery or 20 minutes for redelivery. No reply API retry key is invented; one POST carries all text chunks, no fallback push or partial-delivery notice.

Startup verifies the access token's bot identity through read-only `GET /v2/bot/info`. Status distinguishes successful API authentication from seeing an authenticated webhook; neither proves current dot subscription or end-to-end delivery. API errors are sanitized, redirects are rejected, bodies are capped at 1 MiB and TLS hostname verification is left enabled. Stop aborts requests and waits for owned ingestion/send work.

For native image/audio/file events, `replyContext.mediaRefs` stores an aligned private message ID; public attachment metadata contains no provider locator. `readAttachment` rechecks owner, bot, conversation, integer attachment index, native type and path-safe ID, then uses only `https://api-data.line.me/v2/bot/message/{messageId}/content`. External content URLs, stickers, locations and video are not fetched. The content API receives the existing channel token; it cannot redirect it to another origin. Downloads have a 15-second timeout and an 5-MiB header/stream bound. HTTP 202 is preparation-pending, never treated as successful empty content; deleted/unprepared content returns a sanitized error without retries. Audio decoding/transcription belongs to shared core.

`channel.media.reply` advertises image/audio, but `validateMediaReply` refuses
queueing unless the operator explicitly configured an approved publisher.
`status().mediaPublisherConfigured` and `mediaPublisherRequired` are fixed
booleans projected by core; no key, media URL or private path is returned.

`media-publishing.js` sends 128-KiB chunks using the existing shared pinned HTTPS
transport with an independent Standard-Webhooks-format publisher key. Exact
configured DNS hostname, public address validation, original TLS hostname,
bounded JSON, authorization before each mutation and no redirects remain
mandatory. It accepts no URL or recipient from MCP. No provider/callback/storage
credential is sent to, or used to sign for, the publisher.

`media-host.js` is an explicit opt-in, memory-only reference publisher with a
20-MiB / 8-object cap. It verifies signed raw JSON and a short timestamp window
before allocating data, requires immutable contiguous chunks and matching
SHA-256, and uses fresh random download capabilities instead of deriving them
from any persistent key. Incomplete objects expire after 60 seconds; committed
objects expire after 120 seconds without extension on duplicate commit. Reads
require the exact object path/token and support bounded single byte ranges.
There is no listing API, filesystem media path, account identity or logger.
Cleanup zeroes owned byte buffers but does not claim physical erasure of GC
strings, OS memory or downstream copies.

`run-media-host.js` refuses to read private files without its explicit confirmation
flag, uses the canonical strict private-file reader, binds only 127.0.0.1,
bounds connections/headers/body/time and waits for graceful shutdown. systemd
and reverse-proxy templates are examples only; no live exposure or key is
created during installation/tests. The package includes these examples.

Image replies currently accept JPEG/PNG up to 1 MiB (one original also used as
preview); audio replies accept a structurally checked audio-only M4A up to
60 seconds / 5 MiB. Optional captions are one text object plus one media object
in the same original-token reply call. LINE's generic-file limitation and short
single-use reply window remain unchanged. No push, online TTS, retry or text
fallback follows an uncertain media send.

Primary media schemas: [LINE maintained OpenAPI](https://github.com/line/line-openapi/blob/main/messaging-api.yml),
`ImageMessage` / `AudioMessage`, reviewed on 2026-10-31.

No real LINE account has validated the 120-second fetch lifetime or delayed
playback. The HTTP entrypoint clears its independent response byte copy only
after finish/close; retained objects remain available until their own expiry.
This is best-effort buffer handling, not a physical memory-erasure guarantee.
The proxy example disables request/response buffering and proxy temporary files,
and drops access/error logs for this capability-URL location. It must be merged
into an existing approved TLS frontend, never auto-installed over another site.

The tracked, unreferenced 0.5.1 source tarball is retained. A requested Git-only
cleanup was not executed because automatic approval returned `blocked by policy`
without a more specific reason. Package dependencies, lockfile, release metadata
and installed runtime reference only the verified 0.6.0 tarball.

Synthetic tests exercise raw-body signature failures, wrong bot/owner/group filtering, empty verification, delayed/failed ingestion, event identity, native image/audio/file reads, external URL and path traversal rejection, size limits, 202/410/MIME failures, single-request Unicode splitting, reply expiry, sanitized uncertain sends and request cancellation. No real LINE account, webhook setting, access token or dot subscription is used. Run `npm run check` and `npm test` on Node >=24.15 <25. Media tools require the matching shared-core release; the pinned vendor artifact is updated centrally during coordinated packaging.
