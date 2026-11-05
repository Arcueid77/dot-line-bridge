# Reply with images and audio

[中文](media-hosting.md) · [English](media-hosting.en.md)

LINE retrieves outgoing media through HTTPS. The optional host keeps the temporary objects in memory and expires completed links after two minutes. Enable it only after approval of the domain, independent key and reverse-proxy routes.

| Reply | Bounds |
| --- | --- |
| Image | JPEG/PNG, at most 1 MiB; same object serves as preview |
| Audio | Existing M4A, at most 60 seconds and 5 MiB |
| Caption | At most 5,000 characters in the same final request |
| Generic file | Not available through LINE Messaging API |

## Approved configuration

Prepare an independent publisher key with the documented `whsec_` plus Base64 form (24–64 random bytes) at `/var/lib/dot-bridge/private/line-media/publisher.key`. Keep it distinct from storage, internal service and callback keys. Issuance/storage follows the operator's approval process.

Linux directories are 0700 and files 0600 under the final runtime user. Example `host.json`:

```json
{
  "enabled": true,
  "endpoint": "https://media.example.com/dotbridge/line-media/publish",
  "publicBaseUrl": "https://media.example.com/dotbridge/line-media/media/",
  "signingKeyFile": "/var/lib/dot-bridge/private/line-media/publisher.key",
  "port": 8896
}
```

Add the same `enabled`, `endpoint`, `publicBaseUrl`, and `signingKeyFile` fields in a `mediaPublishing` object inside the existing LINE credentials JSON. Preserve all account fields. Publish and download paths use the same exact approved host.

Temporary URLs grant access to their objects. Keep them out of chat, diagnostics and proxy/CDN logs. If a required proxy is unsupported, resolve that transport path before enabling media; retain domain, public-address and TLS validation.

## Operation

Review actual absolute Node/component paths in the [systemd template](../examples/media-host.service) and merge only the approved routes from the [proxy example](../examples/media-host.nginx.conf) into the existing website.

```sh
LINE_MEDIA_HOST_CONFIG_FILE=/var/lib/dot-bridge/private/line-media/host.json \
/absolute/node /absolute/component/scripts/run-media-host.js --confirm-public-media-host
```

The host listens on `127.0.0.1:8896`. Test images and short audio from the original owner DM after installation. The approximately 55-second LINE reply window also includes upload/hosting work.

The host retains at most eight objects and 20 MiB total. Incomplete uploads expire after one minute, completed objects after two; buffers and per-write copies are cleared when released. Restart invalidates existing links, so coordinate active media work first.

Actual LINE retrieval and delayed playback need account-level acceptance. Local expiry controls this host's access window; copies already fetched by LINE follow the platform's retention. Runtime/proxy layers retain their own logging and physical-erasure rules. The service template disables core dumps and swap.
