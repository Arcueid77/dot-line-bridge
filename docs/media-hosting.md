# 回复图片和语音

LINE 发送图片和音频时，需要让 LINE 服务器从 HTTPS 地址读取文件。DotBridge 提供一套可选的临时托管服务：文件只在内存中停留，链接在两分钟后失效。它默认不启用，也不会自动申请域名、证书、密钥或修改现有网站。

当前支持：

| 回复内容 | 格式与大小 |
| --- | --- |
| 图片 | JPEG、PNG，最多 1 MiB；同一张图兼作预览，暂不提供大图缩略转换 |
| 语音／音频 | M4A，最多 60 秒、5 MiB；桥读取容器中的时长，不把其他格式改后缀冒充 M4A |
| 说明文字 | 最多 5,000 字符，和媒体放在同一次 LINE 回复请求里 |
| 普通文件 | LINE Messaging API 没有通用文件消息，本功能不提供 |

WAV、SILK 或 MP3 需要先转换成 M4A；本服务不会调用在线模型或语音服务生成录音。是否接受具体文件，仍以 LINE 实际返回结果为准。

## 启用前需要确定

1. 一个已经批准的 HTTPS 域名，以及只用于本服务的发布和下载路径。
2. 一枚独立的上传签名密钥。不能复用或从 storage key、MCP service key、事件 callback key 派生。
3. 允许 LINE 服务器凭短期链接读取本次回复的图片或音频。链接是临时的读取凭据，不能贴到聊天、管理页面或日志里。
4. 一个只监听本机的服务和对应的 HTTPS 反向代理路由。它与 MCP 端口、LINE 接收消息的 webhook 是三个不同入口。

账号尚未配置，或上述事项未批准时，继续使用文字回复。

## 私有配置

以下都是路径与格式示例，没有真实密钥。私有目录保持 0700，文件保持 0600，属主为最终运行用户；不能用符号链接、硬链接或放宽权限解决读取失败。

在 `/var/lib/dot-bridge/private/line-media/publisher.key` 安全放入已批准的独立密钥，格式为 `whsec_` 加 24–64 个随机字节的 Base64。程序不会代为生成或补齐密钥。

创建 `/var/lib/dot-bridge/private/line-media/host.json`：

```json
{
  "enabled": true,
  "endpoint": "https://media.example.com/dotbridge/line-media/publish",
  "publicBaseUrl": "https://media.example.com/dotbridge/line-media/media/",
  "signingKeyFile": "/var/lib/dot-bridge/private/line-media/publisher.key",
  "port": 8896
}
```

在已有受保护 LINE 账号 JSON 中加入以下 `mediaPublishing` 对象，其余账号字段继续保持原值：

```json
{
  "mediaPublishing": {
    "enabled": true,
    "endpoint": "https://media.example.com/dotbridge/line-media/publish",
    "publicBaseUrl": "https://media.example.com/dotbridge/line-media/media/",
    "signingKeyFile": "/var/lib/dot-bridge/private/line-media/publisher.key"
  }
}
```

发布与下载必须使用同一个精确域名。配置不接收任意上传网址、外部媒体来源或模型指定的收件人。主机若必须使用尚未支持的代理，上传会停止；不要通过移除必要代理、放宽域名或关闭 TLS 校验绕过。

## 启动与维护

先将 [systemd 模板](../examples/media-host.service) 中的 Node 和组件路径换成当前安装的绝对路径，再按已批准域名合入 [反向代理示例](../examples/media-host.nginx.conf)。示例只说明所需路由，不应覆盖已有网站或另开冲突端口。

手动启动入口如下，仍只监听 `127.0.0.1:8896`：

```sh
LINE_MEDIA_HOST_CONFIG_FILE=/var/lib/dot-bridge/private/line-media/host.json \
/绝对路径/node /组件绝对路径/scripts/run-media-host.js --confirm-public-media-host
```

主服务的检查结果只显示托管是否已配置，不返回域名后的下载路径、链接 token 或上传密钥。安装完成后，再用本人 LINE 私聊分别检查图片和短音频；保持原来的 dot 及唯一订阅。

LINE 的一次性 reply token 仍约 55 秒截止。托管和上传也消耗这段时间；超时后不会改为主动推送。发送结果不明时，只查看原私聊，不自动换文字重发。

托管最多保留 8 个对象、合计 20 MiB。未上传完成的对象一分钟后清除；完成对象两分钟后停止读取并清零内存缓冲区。HTTP 发送使用独立的临时副本，在该次写入结束或连接关闭后清零。重启会立即使这些临时链接失效，因此不要在媒体正在发送时主动重启托管。

两分钟是本服务设定的公开读取期限，不保证 LINE 一定及时抓取或支持以后再播放。真实账号的及时抓取、延后打开和播放仍需要在接入后确认；若平台尚未取得原件时链接已过期，附件可能无法打开。本服务不会自行延长公开期限或重新发布附件。

这些是服务内的逻辑到期和尽力内存清理，不代表操作系统、转储或其他副本已经物理擦除；LINE 已经取得的副本也不由本服务删除。systemd 模板禁用 core dump 和 swap。反向代理、CDN、负载均衡等外层也必须关闭此路径的完整 URI、请求体与错误明细日志，避免记录下载凭据。
