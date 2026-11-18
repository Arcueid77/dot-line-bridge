# LINE for DotBridge

[中文](README.md) · [English](README.en.md)

Connect the bound owner's LINE Official Account DM to the existing ChatGPT dot using LINE Messaging API and the official Secure MCP Tunnel. The [unified distribution](https://github.com/Arcueid77/dot-bridge) composes the independent provider with `dot-bridge-core` and the aggregate router.

Use Node.js >=24.15 and <25 on a continuously available Linux or Windows host. Linux provides systemd; macOS is unverified and feedback is welcome.

## Setup

Prepare the Messaging API channel, existing access token/secret, owner/bot binding and a public HTTPS webhook. Keep the internal webhook and MCP listeners on loopback. [Setup](docs/setup.en.md) covers account management, official signature verification and the original dot's separate event subscription.

```sh
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
node --env-file=/var/lib/dot-bridge/private/line.env scripts/run-live.js --confirm-live
```

Use the unified entry for persistent services and the single Tunnel target. Preserve the original owner binding and stop the prior consumer when migrating.

## Messaging and media

Read owner text, images, audio and files, up to 5 MiB per attachment. Text files include bounded UTF-8/UTF-16 excerpts; protected Linux processing can add PDF/Office extraction and optional transcription. Original bytes remain available. External-hosted content, stickers and locations expose type information only.

LINE's reply token is single-use. The bridge leaves a margin of about 55 seconds and requires the final reply in that window. Complete text is limited to 20,000 characters, split into at most five messages in one final request.

Text is the default reply. An explicitly approved [temporary media host](docs/media-hosting.en.md) adds JPEG/PNG images up to 1 MiB and M4A audio up to 60 seconds/5 MiB, with at most 5,000 caption characters. Source-attachment replies reuse the original image/audio by index. LINE has no generic outgoing file message.

Retain one consumer, database, storage key and subscription. Unknown delivery is reviewed without automatic replay. Detailed implementation and uncompleted real-account acceptance are in [development](docs/development.md).

## Owner notifications

`DOT_BRIDGE_OUTBOUND=owner-text` separately opts into owner text and fixed reminders, at most 2,000 characters. Recurring reminders need an end date. The original dot schedules dynamic content. This capability is separate from recovery of an expired passive reply. See [scheduled messages](https://github.com/Arcueid77/dot-bridge/blob/main/docs/scheduled-messages.en.md).

## Choices, uploads and reminder management

Numbered text choices let the user answer with a selection. A dot environment with programmatic file access can upload generated media in bounded encrypted chunks, verify its size and SHA-256, then submit the source-bound final reply. Files are limited to 5 MiB and this provider's supported media types and formats.

Literal reminders support weekdays, fixed intervals, pause, resume and delivery history. Check `check_line_outbound` before use and supply the saved reminder ID and current revision. Resuming skips old paused occurrences.


## Tasks, consecutive messages and speech

Task tools return a source-bound reference, passive deadline and remaining seconds. The original dot can save one complete text result. The paired owner can use `/tasks` and `/result reference` in the original DM. Source retention applies, and ambiguous delivery stays uncertain.

The protected interaction policy accepts `queue`, for example `{"mode":"batch","window_ms":750,"max_messages":5}`. Modes are `independent`, `serial` and `batch`, defaulting to independent. A batch retains every source and replies through the last source as its anchor. Attachments, quotes and work already started are handled separately, with the existing conversation/member isolation.

Linux operators can install eSpeak NG and the protected audio runtime, then set `DOT_BRIDGE_SPEECH_SYNTHESIS=local-espeak` and `DOT_BRIDGE_SPEECH_VOICE=zh`. The original dot uses `check_line_speech` and `reply_line_speech`, limited to 2000 characters and 60 seconds. The full text is also retained in the task record.

An explicitly rejected one-time proactive send can be retried after owner confirmation using `retry_line_outbound`, its original ID and current revision. The per-channel proactive switch still applies. Recurring reminders keep their edit/resume flow. Hosted-dot stop, reset and approvals use the original platform controls.

## Processing cues and quick actions

Owner DMs can show the native loading animation. Quick replies expose help, status, queue and subscription checks. Signed choice postbacks bind the owner, original chat and first durable selection; repeated clicks preserve that result. Replies still need the roughly 55-second reply-token window. A complete result saved after that deadline is available through task tools or a fresh owner `/result` request. Synthesized speech uses M4A and requires the approved media publisher.
