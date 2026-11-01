# dot-line-bridge

把本人发给 LINE Official Account 的私聊接到原来的 ChatGPT dot，并把 dot 的回答发回原私聊。通过官方 Secure MCP Tunnel 接入 dot，共享服务由 `dot-bridge-core` 提供，总仓库统一管理。

需要 LINE Messaging API channel、已有的 channel access token 和 channel secret，以及一个公网 HTTPS webhook 地址。MCP 端口和内部 webhook 接收端口都只监听本机。

支持文字收发，并可按需读取本人发送的图片、语音和文件，每个附件最多 5 MiB。语音能否直接播放或转写，取决于共享语音组件和当前 dot 的支持。只读取 LINE 自身提供的附件，外部托管内容、贴图和位置暂时只提供类型信息。不支持个人 LINE 账号登录或群聊。

LINE 的回复 token 单次有效且时间很短，dot 需要在收到消息后约 55 秒内提交最终回答；过期后不会自动改成主动推送。文字回答最多 20,000 字符，会在同一次回复请求内分块。

可选的[短期媒体托管](docs/media-hosting.md)可以让 dot 回复 JPEG／PNG 图片、M4A 音频和说明文字。它需要单独批准的 HTTPS 域名、独立上传密钥和托管配置，默认不启用。未配置时继续使用文字，程序不会自动公开附件或打开公网端口。LINE 不提供通用文件消息发送。

[配置与运行](docs/setup.md) · [统一安装入口](https://github.com/Arcueid77/dot-bridge) · [开发说明](docs/development.md)

配置好媒体下载入口后，也可以让 dot 把收到的图片或音频直接发回原私聊，文件由桥按附件编号读取，不需要来回传递很长的编码文本。LINE 仍不支持通用文件回复。

TXT、Markdown、JSON、CSV 等文本附件会提供可读的文字摘录，支持 UTF-8 和带标记的 UTF-16；过长时会明确标记为截断，原文件仍可读取。PDF、Office 等其他文件继续保留原件，不把它们的二进制内容冒充文字。
