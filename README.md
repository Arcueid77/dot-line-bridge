# dot-line-bridge

把本人发给 LINE Official Account 的私聊接到原来的 ChatGPT dot，并把 dot 的回答发回原私聊。通过官方 Secure MCP Tunnel 接入 dot，共享服务由 `dot-bridge-core` 提供，总仓库统一管理。

需要 LINE Messaging API channel、已有的 channel access token 和 channel secret，以及一个公网 HTTPS webhook 地址。MCP 端口和内部 webhook 接收端口都只监听本机。

当前支持文字收发，并向 dot 报告媒体类型及文件名。不会下载图片、音频或文件，也不支持个人 LINE 账号登录或群聊。LINE 的回复 token 单次有效且时间很短，dot 需要在收到消息后约 55 秒内提交最终回答；过期后不会自动改成主动推送。

[配置与运行](docs/setup.md) · [统一安装入口](https://github.com/Arcueid77/dot-bridge) · [开发说明](docs/development.md)
