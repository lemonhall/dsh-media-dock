# dsh-media-dock 📺

DSH 右侧栏的**媒体台** —— 把抖音 / YouTube 链接丢进来，本机下载、本机转写，字幕进面板，**一键让 Agent 总结**。

> 这是给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 右侧栏做的一排日常插件之一。
> 右侧栏本来就是 DSH 的「apps 入口」—— 官方的文件/终端/浏览器和第三方插件走**完全同一套机制**。

## 它解决的是什么

看一个 11 分钟的长视频，我想要的是**它的文字**，不是那 11 分钟。

而"视频 → 文字 → 总结"这条链，**别人做不成**：下载要本机 `yt-dlp`，转写要本机模型，总结要一个能读文件的 Agent —— 三样凑齐才有意义。所以它天然是个 DSH 插件，而不是一个网页工具。

## 流水线（每一步都踩过坑）

```
贴链接 / 按「📋 扒剪贴板」
   ↓ ① yt-dlp 下载（走 video-download SKILL 那套：代理按站点、cookie 阶梯、重试）
   ↓    优先抓现成字幕（零成本、最准）
   ↓ ② 没字幕才 ffmpeg → 16kHz 单声道 PCM16 WAV（按官方上限切段）
   ↓ ③ ctx.speechToText.transcribe()（SenseVoice，本地跑，中文强）
   ↓ ④ 字幕存进本插件状态
   ↓ ⑤ 面板里点「让 Agent 总结」→ 直接在对话里开始总结
```

## 效果

![面板](https://cdn.jsdelivr.net/gh/lemonhall/dsh-media-dock@main/docs/screenshot-panel.png)

（图只截右侧栏面板。我这台机器桌面左下角有真名，所以截图从来不整屏。）

## 它能干什么

- **抖音 / YouTube / B站 / X 等**（认不出站点也照样交给 yt-dlp —— 它支持 1000+ 站点）
- **两段式**：先抓现成字幕（YouTube 大多有），没有才本地转写
- **长视频自动切段** —— 段长**问官方要**（`maxAudioBytes` / `maxDurationSeconds`），不拍脑袋
- **「📋 扒剪贴板」**：刷抖音时点「分享 → 复制链接」，回来按一下直接开工
- **「让 Agent 总结」**：走客户端 `ISession.prompt`，**按下就在对话里开始**（不是写个留言等我发现）
- `media_panel` 工具：`add` / `list` / `read` / `status` / `retry` / `remove` / `clear` —— **Agent 能直接读字幕全文**

## 依赖（三样）

| 依赖 | 作用 | 备注 |
| --- | --- | --- |
| `yt-dlp` | 下载 + 抓字幕 | 本机已装（`WinGet\Links\yt-dlp.exe`） |
| `ffmpeg` | 转 16kHz 单声道 PCM16 WAV | 本机已装（chocolatey） |
| 官方 `speechToText` | 本地转写 | **可选** —— 没装就只能抓现成字幕 |

**STT 是可选接入**（按官方契约用 `ctx.get('speechToText')` + undefined 检查）：
装了就用 SenseVoice 本地转写，没装就只抓现成字幕，**不会因为缺它而报错**。

## 装

```
# 桌面版 GUI：右侧栏「插件 → 添加插件」→ 填 dsh-media-dock
# 或者 CLI：
dsh plugin --profile desktop add dsh-media-dock

# 开发者想用本地目录直接挂：
plugin_manager install_bundle target=link:E:\development\dsh-media-dock
```

装完**重启一次**（界面半边在启动时固化），然后右侧栏点「**+**」选「媒体台」。

## 它是怎么work的

```
lib/index.js    宿主半：yt-dlp/ffmpeg 流水线 + 路由 + media_panel 工具
lib/url.js      纯函数：URL 解析 / 时长 / 切段 / 字幕清洗（36 项单测）
lib/state.js    本地状态（原子写）
lib/client.js   右侧栏 tab（整个模块包在 IIFE 里 —— DSH 把所有客户端插件拼成一个脚本，
                顶层 const 会跨插件撞名，实测撞过一次直接把应用挡在启动之外）
```

## 已知限制

- **抖音 / X 不能嵌在侧栏里看**：抖音会认出 Electron webview（页面外壳能加载、播放器一直"加载中"），
  而官方那个 browser tab 的 webview 不归第三方管、改不了。所以这两个走**系统浏览器**刷 + 剪贴板扒。
  YouTube 不受影响，可以真"边看边扒"。
- **抖音必须带 cookie**（`Fresh cookies (not necessarily logged in) are needed`）。默认会自动把 Chrome 的
  cookie 库**复制成迷你 profile** 再读（绕开 issue 7271 的锁，Chrome 开着也行）；也可以配 `cookiesFile`
  指向导出的 `cookies.txt`（最稳，不受 Chrome 运行状态影响）。
- **转写是有界的**：官方限制 `maxAudioBytes=4MB` / `maxDurationSeconds=120`，所以长视频必然切段
  （11 分钟 = 7 段）。段与段是独立识别的，**跨段的一句话可能被切断**。
- **转写有听错**：`SenseVoiceSmall (INT8)` 日常叙述很准，专业术语容易错
  （实测：共沸物 → "供废物"、辛烷值 → "锌烷值"、蔗渣 → "热扎"、葡语 → "普语"）。
  要更准要么换更大的模型，要么加术语纠正表。
- **不做**：视频摘要之外的二次加工（剪辑/翻译/配音）、播放列表批量、字幕时间轴对齐。

## 踩过的坑（都写进代码注释了）

这个插件是这批里最折腾的一个，六个 bug 每个都是实测出来的：

1. **`client.download()` 不是 async iterable**（那是 imapflow 的坑）—— 类似地，`yt-dlp --print` 的路径在这台
   机器上**压根没给出可用路径**，得扫目录兜底；这个 bug 藏了很久，因为"现成字幕"那条路**提前 return** 了。
2. **`Invalid speech WAV`**：ffmpeg 默认往 WAV 里塞 `LIST/INFO/ISFT "Lavf…"` 元数据 chunk，
   官方校验的是**规范** PCM16 —— 加 `-fflags +bitexact -map_metadata -1`。
3. **`Invalid speech audio size`**：我把段长拍成 180 秒（5.8MB），而官方上限是 4MB / 120 秒 ——
   **得问它要，不能猜**。
4. **一个漏掉的 cookie 换了两张脸**：探元数据那步没走 cookie 阶梯 → `durationSec` 变 0 →
   切段算出空方案 → 退化成"整段当一段" → 又报大小错。**看起来是大小问题，其实是探测问题。**
5. **代理按站点**：抖音/B站这类国内站点**绝不能走代理**；而且即使不走代理也要**显式传 `--proxy ""`**，
   否则 yt-dlp 会读环境变量里的 `HTTP_PROXY`，等于偷偷走了。
6. **"关窗口 ≠ 退进程"**：Chrome 关了窗口还剩 12 个进程，锁着 cookie 库 —— 所以要复制成迷你 profile。

## License

MIT
