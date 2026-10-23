# dot-line-bridge

把本人发给 LINE Official Account 的私聊接到原来的 ChatGPT dot，并把 dot 的回答发回原私聊。通过官方 Secure MCP Tunnel 接入 dot，共享服务由 `dot-bridge-core` 提供，总仓库统一管理。

需要 LINE Messaging API channel、已有的 channel access token 和 channel secret，以及一个公网 HTTPS webhook 地址。MCP 端口和内部 webhook 接收端口都只监听本机。

支持文字收发，并可按需读取本人发送的图片、语音和文件，每个附件最多 8 MiB。语音能否直接播放或转写，取决于共享语音组件和当前 dot 的支持。只读取 LINE 自身提供的附件，外部托管内容、贴图和位置暂时只提供类型信息。不支持个人 LINE 账号登录或群聊。

LINE 的回复 token 单次有效且时间很短，dot 需要在收到消息后约 55 秒内提交最终回答；过期后不会自动改成主动推送。当前回答为文字：LINE 的图片／音频消息需要公网 HTTPS 媒体地址，本桥没有配置这样的托管服务，也不会自动公开您的附件。

[配置与运行](docs/setup.md) · [统一安装入口](https://github.com/Arcueid77/dot-bridge) · [开发说明](docs/development.md)
