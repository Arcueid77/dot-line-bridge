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

For native image/audio/file events, `replyContext.mediaRefs` stores an aligned private message ID; public attachment metadata contains no provider locator. `readAttachment` rechecks owner, bot, conversation, integer attachment index, native type and path-safe ID, then uses only `https://api-data.line.me/v2/bot/message/{messageId}/content`. External content URLs, stickers, locations and video are not fetched. The content API receives the existing channel token; it cannot redirect it to another origin. Downloads have a 15-second timeout and an 8-MiB header/stream bound. HTTP 202 is preparation-pending, never treated as successful empty content; deleted/unprepared content returns a sanitized error without retries. Audio decoding/transcription belongs to shared core.

`channel.media.reply` remains empty. LINE image/audio sends require operator-hosted public HTTPS URLs; binary uploads are not supported by that API and this change does not add public media hosting or invent a file-message type. The short single-use reply window and text-only send path are preserved.

Synthetic tests exercise raw-body signature failures, wrong bot/owner/group filtering, empty verification, delayed/failed ingestion, event identity, native image/audio/file reads, external URL and path traversal rejection, size limits, 202/410/MIME failures, single-request Unicode splitting, reply expiry, sanitized uncertain sends and request cancellation. No real LINE account, webhook setting, access token or dot subscription is used. Run `npm run check` and `npm test` on Node >=24.15 <25. Media tools require the matching shared-core release; the pinned vendor artifact is updated centrally during coordinated packaging.
