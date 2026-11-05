# Connect LINE

[中文](setup.md) · [English](setup.en.md)

Use [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/overview/) with an Official Account that the owner adds as a friend. Prefer the existing account/channel and arrange migration if its webhook is already used elsewhere.

## Account and private binding

Enable Messaging API for the account in [Official Account Manager](https://manager.line.biz/) and confirm its provider. In the same channel in [Developers Console](https://developers.line.biz/console/), obtain the existing channel secret/token and the owner's **Your user ID**. The owner's Business ID may need association with their LINE account. Obtain `botUserId` through the same token's read-only `GET /v2/bot/info`.

Keep the actual values in a protected JSON file:

| Field | Value |
| --- | --- |
| `ownerId` | Owner's user ID under this channel/provider |
| `conversationId` | Same value as `ownerId` |
| `botUserId` | Official bot-info response's `userId` |
| `channelSecret` | This Messaging API channel's secret |
| `channelAccessToken` | Its existing approved access token |

Approve credential issuance or rotation through the official flow when needed. Startup verifies the token's bot identity. Use private handoff rather than chat or Git for the real file.

Use Node.js >=24.15 and <25. Install the repository lockfile with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`, or use the unified distribution. Linux directories are 0700 and files 0600, owned by the runtime user; Windows uses private ACLs.

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8806
LINE_TRANSPORT=webhook
LINE_WEBHOOK_PORT=8895
LINE_CREDENTIALS_FILE=/var/lib/dot-bridge/private/line/credentials.json
TUNNEL_SERVICE_KEY_FILE=/var/lib/dot-bridge/private/line/service-key
STORAGE_KEY_FILE=/var/lib/dot-bridge/private/line/storage-key
DATABASE_PATH=/var/lib/dot-bridge/line/bridge.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/locks
CALLBACK_TRANSPORT_MODE=standard
```

8806 is an explicit combination example; the component's built-in MCP port is 8795. Use independent service keys and preserve the original storage key/database. Prepare the data/lock directories under the final user.

## LINE HTTPS webhook

The internal receiver accepts `POST http://127.0.0.1:8895/webhook`. Add a dedicated path to an approved existing HTTPS reverse proxy:

```nginx
location = /dotbridge/line {
    client_max_body_size 256k;
    proxy_pass http://127.0.0.1:8895/webhook;
    proxy_set_header Host 127.0.0.1:8895;
    proxy_set_header Origin "";
}
```

Set the chosen public HTTPS path as the channel's Webhook URL. Run Verify, then enable Use webhook. The proxy preserves the raw body and `x-line-signature`; the bridge verifies HMAC-SHA256 before accepting owner data. MCP and the internal receiver stay on loopback.

Add the Official Account as a friend from the owner's LINE app. Review the account's automatic/greeting replies so their messages can be distinguished from the dot's answer. Optional LINE webhook redelivery retains the platform's own delivery guarantees.

## Original dot

```sh
node --env-file=/var/lib/dot-bridge/private/line.env scripts/run-live.js --confirm-live
```

Use the unified entry for persistent services and one aggregate Tunnel target. Refresh the original plugin and reuse/renew `line.message.created` with `conversation=owner`.

The original dot's outbound event callback is separate from the LINE inbound webhook. Its actual subscription supplies the callback and signing material. Approve only the returned exact hostname in `CALLBACK_HOSTS`; keep full callback URLs and keys private. The routed diagnostic is `check_line_readiness`, with `check_line_setup` on the direct backend.

## Replies and maintenance

Verify one normal owner DM returns once, then test needed media. LINE's single-use reply token has a short lifetime; the bridge uses about 55 seconds including processing/upload time. Expired passive replies stay expired. Owner proactive notifications are a separately approved capability.

One final request can contain at most five text blocks, totaling 20,000 characters. Incoming images/audio/files are at most 5 MiB and downloaded from official LINE content endpoints. Protected Linux processing can add bounded document excerpts or local transcription; original bytes and extraction state remain available.

The optional [media host](media-hosting.en.md) adds JPEG/PNG images up to 1 MiB and M4A audio up to 60 seconds/5 MiB, with at most 5,000 caption characters. LINE provides no generic outgoing file message.

| Symptom | Check |
| --- | --- |
| Startup identity failure | Token and bot ID from the same channel |
| Verify failure | Exact HTTPS path, secret, raw body and signature forwarding |
| Verify passes but no owner event | Use webhook, owner binding, DM target and dot subscription |
| Late reply | Dot completion within the short passive window |
| Attachment unavailable | Processing delay, platform expiry, supported source and size |
| `uncertain` | Inspect the original DM before any manual recovery |

Preserve the database/storage key and stop the old consumer before migration. Update approved credentials privately and restart through the established procedure.
