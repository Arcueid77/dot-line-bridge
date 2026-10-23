# 连接 LINE

本渠道使用 [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/overview/)。您在 LINE 中添加自己的 Official Account，再给它发私聊，由桥接转交给原 ChatGPT dot。需要已有的 Messaging API channel，不能用个人 LINE 登录密码或普通 webhook URL 代替。

## 准备配置

已有 Official Account 时优先复用。还没有对应的 Messaging API channel 时，在 [LINE Official Account Manager](https://manager.line.biz/) 为该账号启用 Messaging API，并选择由您管理的 provider；没有 Official Account 才先创建。现在不能直接从 Developers Console 创建 Messaging API channel。provider 一旦选定便不能更换，请先确认归属。[官方创建步骤](https://developers.line.biz/en/docs/messaging-api/getting-started/)

打开 [LINE Developers Console](https://developers.line.biz/console/) 中同一个 Messaging API channel：

1. 在 **Basic settings** 取得 **Channel secret** 和 **Your user ID**。后者是您本人在这个 provider 下的用户 ID，不是昵称或用于加好友的 LINE ID。若看不到 Your user ID，先将用于登录的 Business ID 关联到您本人的 LINE 账号。[获取本人 ID](https://developers.line.biz/en/docs/messaging-api/getting-user-ids/)
2. 在 **Messaging API** 取得该 channel 的现有 access token；没有 token 时，由您在控制台确认签发后再交接。简单手动配置可使用该页的 long-lived token。已有有效 token 时不要随手 Reissue，重新签发可能使旧 token 失效。[token 说明](https://developers.line.biz/en/docs/basics/channel-access-token/)
3. bot 用户 ID 是使用同一 token 调用只读 `GET /v2/bot/info` 返回的 `userId`，不是 `@` 开头的 Basic ID。请在受保护的配置流程中取得并保存，不要把整个响应贴到聊天。服务启动时还会再次核对 token 与 bot 用户 ID。[bot 信息接口](https://developers.line.biz/en/reference/messaging-api/#get-bot-info)

请通过私有文件交接这些配置，不要发到聊天或提交到 Git。

在 `/etc/dot-bridge/private/line.credentials.json` 写入：

| 字段 | 填什么 |
| --- | --- |
| `ownerId` | 同一 channel 的 Basic settings → Your user ID |
| `conversationId` | 与 `ownerId` 相同，限定本人私聊 |
| `botUserId` | 同一 token 调用 `/v2/bot/info` 返回的 `userId` |
| `channelSecret` | 该 Messaging API channel 的 secret |
| `channelAccessToken` | 同一个 channel 的现有 access token |

使用 Node.js `>=24.15 <25`，通过[总仓库](https://github.com/Arcueid77/dot-bridge)安装固定版本。单独使用此仓库时执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`。私有目录 `0700`、文件 `0600`，属主为最终运行用户；Windows 由共享组件检查私有文件 ACL。

`/etc/dot-bridge/private/line.env`：

```dotenv
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=live
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
HOST=127.0.0.1
PORT=8795
LINE_TRANSPORT=webhook
LINE_WEBHOOK_PORT=8895
LINE_CREDENTIALS_FILE=/etc/dot-bridge/private/line.credentials.json
TUNNEL_SERVICE_KEY_FILE=/etc/dot-bridge/private/line.service-key
STORAGE_KEY_FILE=/etc/dot-bridge/private/line.storage-key
DATABASE_PATH=/var/lib/dot-bridge/line/bridge.sqlite
BRIDGE_LOCK_DIRECTORY=/var/lib/dot-bridge/locks
CALLBACK_TRANSPORT_MODE=standard
```

运行用户必须拥有数据库目录与锁目录。每个渠道和聚合路由器各用独立的 service key；存储 key 与原数据库一起保留，不能在迁移时随意更换。程序不会自动新建或替换凭据。

## 接通 LINE webhook

LINE 消息从公网 HTTPS webhook 进入桥接；dot 的工具请求通过 Secure MCP Tunnel 进入聚合路由器。这是两个入口。

桥接默认接收 `POST http://127.0.0.1:8895/webhook`。由您管理的 HTTPS 反向代理只转发指定路径。例如在已有 Nginx HTTPS server 中加入：

```nginx
location = /dotbridge/line {
    client_max_body_size 256k;
    proxy_pass http://127.0.0.1:8895/webhook;
    proxy_set_header Host 127.0.0.1:8895;
    proxy_set_header Origin "";
}
```

先确定您管理的域名和专用 HTTPS 路径，再在 LINE Developers Console 的 Messaging API 页面，将 Webhook URL 设置为该服务器的 `https://您的域名/dotbridge/line`。点 Verify 成功后，打开 Use webhook。一个 channel 只能配置一个 webhook 地址；若现有账号已交给其他服务使用，先协调迁移，不直接覆盖。签名有效的空验证请求会返回成功。若希望 LINE 在暂时入库失败后重投，可在该页面启用 Webhook redelivery；它仍不保证所有失败都会补投。[官方 webhook 设置](https://developers.line.biz/en/docs/messaging-api/building-bot/#set-a-webhook-url)

在该页扫描 Official Account 的加好友二维码，用本人 LINE 添加账号。若希望只由 dot 回答，可在 LINE Official Account Manager 关闭该账号原有的 Auto-reply messages；Greeting messages 也可按需关闭，避免把平台自动回复误当成 dot 的回答。[官方回复设置](https://developers.line.biz/en/docs/messaging-api/building-bot/#settings-on-line-official-account-manager)

代理必须原样保留请求体和 `x-line-signature`，转发的 `Host` 改为内部接收地址并去掉 `Origin`，如上所示。桥接先用 channel secret 验证原始字节的 HMAC-SHA256 签名，再读取 JSON 和绑定信息。不要把 MCP 端口 `8795` 或内部 webhook 端口 `8895` 直接绑定到公网。总仓库只启动内部监听，不会替您修改 TLS、域名、Nginx 或防火墙。

## 连接原 dot

单独运行：

```sh
node --env-file=/etc/dot-bridge/private/line.env scripts/run-live.js --confirm-live
```

长期运行从总仓库生成 systemd 服务，把 `line` 加入聚合路由器的 live 渠道列表。保持原来的一个官方 Tunnel，target 指向聚合路由器并引用聚合 key 文件。升级到带媒体支持的共享组件后，原 dot 刷新插件，应能发现 `get_line_message`、`get_line_attachment`、`reply_to_line`、`get_line_reply_status`，再订阅 `line.message.created`，限定 `conversation=owner`。

原 dot 的事件 callback 是另一条从桥接出站的 HTTPS 通知。如果首次订阅提示回调域名尚未批准，取得原 dot 真实请求中的准确 hostname，由您确认后写入 `CALLBACK_HOSTS` 并重启本渠道，再尝试一次。配置名是 `CALLBACK_HOSTS`，不是 `MCP_CALLBACK_ALLOWED_HOSTS`。不使用通配符，也不把 LINE Webhook URL 填进去。不要在聊天中交接完整 callback 或签名密钥。

## 回复与维护

先用本人 LINE 私聊发一条文字，确认 dot 的最终回答回到同一个私聊。之后尝试一张图片、一段短语音和一个小文件。本人 ID 始终来自已核对的配置，不能将第一个发来消息的人自动配对。普通重启保留加密数据库和 storage key；换机器前停止旧消费者，避免同时消费。

LINE reply token 只能使用一次，通常需要在收到 webhook 后一分钟内调用。桥接留出余量，按约 55 秒截止；重投事件也不会获得无限延长的时间。dot 思考太久或排队可能错过窗口，已入库消息的回复会过期；到达时已经过期的消息不会再交给 dot。请让 dot 用一条简短最终答案及时回复。本版本不自动切换为 push，以免增加发送范围、费用或造成重复。

长答案会在一次回复请求内分成最多 5 个 LINE 文字消息，总文本最多 20,000 字符；这算一次最终回复请求。

图片、语音和文件每个最多 8 MiB。dot 用消息的附件序号读取原件，桥通过 LINE 官方内容接口下载，您不需要提供下载网址。语音有时需要等待 LINE 处理完成；平台也会在一段时间后清除原件，因此附件不保证长期可读。语音转写依赖共享语音组件是否支持该编码。若没有可用转写，dot 应请您改发文字，而不是根据“收到语音”猜测内容。

当前仅提供文字回答。LINE 发送图片或音频要求可公开访问的 HTTPS 媒体地址；本桥不含公网媒体托管，不会自动上传到第三方存储或打开附件下载端口。LINE Messaging API 也不提供普通文件消息的发送接口。需要这些发送能力时，应先单独确定托管和授权方案。[官方消息类型](https://developers.line.biz/en/reference/messaging-api/#message-objects)

| 现象 | 处理方式 |
| --- | --- |
| 启动时身份核对失败 | 核对 bot 用户 ID 和 access token 是否来自同一 channel |
| Verify 失败 | 核对公网 HTTPS 代理、精确路径、channel secret，以及原始请求体是否被修改 |
| Verify 成功但私聊不进来 | 核对 Use webhook、本人 ID、私聊对象，以及原 dot 的有效订阅 |
| 桥已入库但 dot 不答 | 检查原 dot 的事件订阅是否启用；Webhook Verify 和 Tunnel 工具可用都不能代替订阅 |
| 订阅只报通用错误 | 保留一次尝试的时间与脱敏错误，检查是否到达 `events/subscribe` 及失败阶段，不反复创建 |
| 附件暂时不能读 | LINE 可能仍在处理或已删除原件；也请检查 8 MiB 限制。外部托管内容暂不读取 |
| 收到消息但回复过期 | dot 未在短暂回复窗口内完成，先用简短问题确认整个流程 |
| `uncertain` 状态 | 先查看原私聊是否已经收到；不要自动重发 |

维护 token 或 secret 时，通过私有文件手动更新再重启。程序不会自动重发 token 申请，也不会扩大 channel 权限。
