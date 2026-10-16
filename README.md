# VideoHarvest

> **全能网页流媒体视频下载扩展（对标 Video DownloadHelper）**  
> 一套代码同时支持 **Chrome（Manifest V3）** 与 **Firefox（Manifest V2）**，支持直链音视频、HLS（m3u8 多码率流、AES-128 解密、fMP4/CMAF、ByteRange）、DASH（MPD，SegmentTemplate/SegmentTimeline）。

---

## 一、 功能特性

* 🎬 **智能媒体嗅探与防碎片污染**：
  * 基于 `webRequest` 深度监听网络请求头与媒体类型；
  * 内置智能分片过滤，自动剔除 `init.mp4`、`init.m4s`、`.ts` 等微小切片碎片，避免列表被刷屏；
  * 自动过滤 `< 150KB` 的临时探测请求，只保留真实完整的媒体文件。
* 🎚️ **多码率自动聚合（清晰度下拉选单）**：
  * 自动解析 HLS Master Playlist，将 1080p、720p、480p 等子码率收拢至**同一个视频卡片**；
  * 提供清晰度下拉切换器（如 `MP4 720p`、`MP4 480p`），用户可自主选择期望分辨率下载。
* 🖼️ **视频封面与精确时长展示**：
  * 自动抓取网页内 `<video poster>` 缩略图；
  * 通过解析 HLS `#EXTINF` 自动精确累加视频时长（如 `00:56`），并在封面角标清晰标注。
* ⚡ **多协议流媒体下载引擎**：
  * **直链下载**：MP4、WebM、FLV、MKV、MP3、AAC、OGG 等常规音视频；
  * **HLS (m3u8)**：支持标准 MPEG-TS、fMP4 (CMAF)、`#EXT-X-BYTERANGE` 范围请求，以及 AES-128 在线解密；
  * **DASH (mpd)**：支持 `SegmentTemplate`（`$Number$`、`$Time$` 时间戳模式）及 `SegmentList`。
* ⚙️ **灵活配置中心**：
  * 支持自定义分片下载并发数（1 ~ 16 线程）；
  * 支持文件名自定义模板（支持 `{title}` 页面标题、`{host}` 域名、`{date}` 日期变量）。

---

## 二、 架构设计

```text
src/
├── background/
│   ├── sw.js        # 后台核心：消息路由、offscreen 文档生命周期管理、配置装载
│   └── sniffer.js   # 智能媒体嗅探器：过滤碎片、HLS 清单解析、码率聚合、Badge 计数
├── engine/
│   ├── engine.html  # Chrome Offscreen 文档（宿主容器，绕过 Service Worker 无 DOM/Blob 限制）
│   ├── engine.js    # 流下载执行引擎：多协程抓取分片、AES-128 解密、拼装 Blob 交付 downloads API
│   ├── hls.js       # HLS 解析器（Master 多码率、Media 清单、EXT-X-KEY、EXT-X-MAP、EXT-X-BYTERANGE）
│   └── dash.js      # DASH 解析器（MPD、Representation、SegmentTimeline 时间轴计算）
├── popup/           # 弹出层：VDH 风格卡片布局、缩略图展示、码率下拉菜单、实时下载进度条
├── options/         # 设置页：并发数设置、命名规则模板
├── lib/             # browser-polyfill（跨浏览器 Promise 适配）、url-util
└── icons/           # 全套透明高清微拟物应用图标（16x16, 32x32, 48x48, 128x128）
```

### 核心分叉机制
1. **Chrome (Manifest V3)**：
   - Service Worker 环境下无法创建 Blob URL 和访问 DOM；
   - 采用 Chrome 官方标准的 **Offscreen Document（离屏文档）** 运行下载合并引擎，通过扩展内部消息与后台通信。
2. **Firefox (Manifest V2)**：
   - 采用常驻后台页（Persistent Background Page），直接同步载入解析引擎，直调运行，零消息中转开销。

---

## 三、 本地构建与加载

### 1. 编译构建
本项目零第三方 npm 生产依赖，使用原生 Node.js 构建：

```bash
# 执行打包构建
node build.mjs
```

构建完成后产物位于：
* `dist/chrome`：用于 Chrome / Edge / 360 / Brave 等 Chromium 内核浏览器。
* `dist/firefox`：用于 Mozilla Firefox。

### 2. 加载到浏览器

* **Google Chrome / Microsoft Edge**：
  1. 访问 `chrome://extensions`（Edge 访问 `edge://extensions`）；
  2. 开启右上角 **「开发者模式（Developer Mode）」**；
  3. 点击 **「加载已解压的扩展程序（Load unpacked）」**；
  4. 选择本项目目录下的 `dist/chrome` 文件夹即可。
* **Mozilla Firefox**：
  1. 访问 `about:debugging#/runtime/this-firefox`；
  2. 点击 **「临时载入附加组件（Load Temporary Add-on）」**；
  3. 选择本项目目录下的 `dist/firefox/manifest.json` 文件。

---

## 四、 常见问题与说明

1. **为什么部分页面播放时嗅探不到视频？**
   * 部分网站在页面初次加载时并不请求视频流，需在页面中点击播放后，媒体请求触发网络层监听，插件方可捕获。
2. **下载速度如何调节？**
   * 点击弹出层底部的「设置」，可以修改并发分片数量（默认 4，可调至 8~16）。注意：过高的并发可能会受到部分站点 CDN 限速策略的限制。

---

## 五、 免责声明

本扩展仅供合法的个人学习、离线研究及受版权方授权的内容备份使用。请勿将本扩展用于任何侵犯他人知识产权或违反服务条款的商业行为，使用者需自行承担因违规使用产生的法律责任。
