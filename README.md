# VideoHarvest

<p align="center">
  <img src="src/icons/icon-128.png" width="96" height="96" alt="VideoHarvest Logo" />
</p>

<p align="center">
  <strong>全能跨浏览器网页流媒体视频下载扩展</strong><br>
  极速嗅探 · 零外部运行依赖 · 原生音视频混流 · 动态悬停微预览
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-Manifest_V3-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome MV3" />
  <img src="https://img.shields.io/badge/Firefox-Manifest_V2-FF7139?style=flat-square&logo=firefoxbrowser&logoColor=white" alt="Firefox MV2" />
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/Dependencies-Zero_NPM-blueviolet?style=flat-square" alt="Zero NPM" />
</p>

<p align="center">
  <img src="screenshot_showcase.png" width="800" alt="VideoHarvest UI Showcase" />
</p>

---

## 🌟 核心特性

### 1. 全协议流媒体下载引擎
* **直链音视频**：支持 MP4、WebM、FLV、MKV、MP3、AAC、OGG 等常见直链格式；
* **HLS (m3u8)**：
  * 支持标准 MPEG-TS、fMP4 (CMAF)、`#EXT-X-BYTERANGE` 范围请求；
  * 原生支持 **AES-128** 密文切片在线解密；
  * 自动将分段音频轨与视频轨进行自适应重封装（Remux），确保下载文件音画同步；
* **DASH (mpd)**：支持 `SegmentTemplate`（`$Number$`、`$Time$` 时间戳模式）及 `SegmentList`。

### 2. 极致的媒体嗅探与精准识别
* **智能去噪防碎片**：基于 `webRequest` 深度监听底层网络流，自动过滤 `init.mp4`、`init.m4s`、`.ts` 等碎片以及 `< 150KB` 的探测请求；
* **清晰度聚合与多码率收拢**：自动解析 Master Playlist，将 1080p、720p、480p 等子流归拢在**同一个视频卡片**下，并提供下拉选单与预估体积；
* **Canvas 现场抓帧与多级封面**：
  * 面对 Twitter/X 等动态卸载封面 DOM 的流媒体网页，嗅探器直接通过 Canvas 对正在播放的 `<video>` 现场抓取高清首帧，100% 还原真实播放画面；
  * 结合推文正文大图穿透与时长严格比对，彻底杜绝“货不对板”或“黑屏占位”。

### 3. 缩略图鼠标悬停动态微预览
* **秒级静音预览**：将鼠标悬停在卡片缩略图上，视频自动静音循环播放微预览；
* **轻量级 HLS 切片解压**：内置轻量 MSE 播放内核，HLS 流自适应拉取前几秒切片微播，移出即销毁，零多余网络与内存占用；
* **智能防抖**：内置 160ms 防抖算法，避免鼠标快速掠过卡片时发起非预期网络请求。

### 4. 下载任务持久化与后台同步
* **随关随开，无缝追踪**：在扩展弹窗中点击下载后，即使关闭面板，后台下载与混流任务依然稳步推进；再次打开面板时秒级恢复下载百分比与进度动画。

### 5. 主动重新检测与智能重载引导
* **主动 DOM 探测**：点击左下角【刷新】按钮，自动注入扫描脚本检测页面上所有 `<video>`、`<audio>` 与直链媒体；
* **流媒体恢复引导**：若用户此前清空了网络流记录，刷新按钮智能检测到页面存在播放中的 Blob 流时，将提供一键重载网页重新捕获引导。

### 6. 自定义地址/网页静默嗅探
* 支持在顶部输入框粘贴 `m3u8`、`mpd`、`mp4` 直链快速提取；
* 支持直接输入网页播放页链接，由后台静默标签页自动执行嗅探提取，无需用户手动打开页面。

---

## 🏗️ 架构设计

```text
video-harvest/
├── src/
│   ├── background/
│   │   ├── sw.js            # 后台核心：消息路由、Offscreen 生命周期管理、状态池与持久化
│   │   └── sniffer.js       # 智能媒体嗅探器：过滤去噪、Canvas 抓帧、Master 聚合、Badge 计数
│   ├── engine/
│   │   ├── engine.html      # Chrome Offscreen 容器（绕过 MV3 Service Worker 无 DOM/Blob 限制）
│   │   ├── engine.js        # 下载与合并引擎：多并发分片拉取、AES-128 解密、音视频 Mux 组装
│   │   ├── hls.js           # 轻量 HLS 解析器（Master、Media、EXT-X-KEY、EXT-X-MAP）
│   │   └── dash.js          # DASH 解析器（MPD、Representation、SegmentTimeline）
│   ├── popup/
│   │   ├── popup.html       # 扩展弹窗界面
│   │   ├── popup.js         # 交互逻辑、清晰度选择、进度同步、悬停微预览控制器
│   │   └── popup.css        # 现代暗黑极简工业风设计系统
│   ├── options/             # 设置中心：并发数调配、文件命名模板
│   ├── lib/                 # 核心基础库：browser-polyfill, mux.min.js, hls.player.min.js
│   └── icons/               # 矢量微拟物透明图标集合 (16/32/48/128)
├── dist/                    # 构建产物（dist/chrome 与 dist/firefox 及打包好的 ZIP）
├── docs/                    # 官方产品展示与静态站点（支持 GitHub Pages）
└── build.mjs                # 原生零依赖打包构建脚本
```

### 双浏览器适配规范
| 运行环境 | 技术方案 | 优势 |
| :--- | :--- | :--- |
| **Chrome (MV3)** | Service Worker + Offscreen Document | 符合 Chrome 商店最新审查规范，通过独立的离屏沙盒规避 Service Worker 无法使用 DOM / Blob 的限制 |
| **Firefox (MV2)** | Persistent Background Page | 原生常驻后台，直接调起引擎，零 IPC 消息中转损耗 |

---

## 🚀 本地构建与安装

### 1. 编译构建
本项目零第三方 npm 生产运行时依赖，只需本机具备 Node.js（v16+）：

```bash
# 执行打包构建
node build.mjs
```

构建输出：
* `dist/chrome/` 及 `dist/chrome.zip`：适配 Chrome / Edge / Brave / 360 等 Chromium 内核浏览器。
* `dist/firefox/` 及 `dist/firefox.zip`：适配 Mozilla Firefox。

### 2. 加载到浏览器

#### Chromium 系列（Google Chrome / Microsoft Edge 等）
1. 打开浏览器并访问 `chrome://extensions`（Edge 访问 `edge://extensions`）；
2. 开启右上角 **「开发者模式（Developer Mode）」**；
3. 点击 **「加载已解压的扩展程序（Load unpacked）」**；
4. 选择本项目中的 `dist/chrome` 目录即可载入。

#### Mozilla Firefox
1. 访问 `about:debugging#/runtime/this-firefox`；
2. 点击 **「临时载入附加组件（Load Temporary Add-on）」**；
3. 选择本项目中的 `dist/firefox/manifest.json` 即可载入。

---

## ⚙️ 个性化设置

点击弹出层底部的 **「设置」** 页面，可根据个人网络环境自定义：
* **分片并发线程数**：支持 1 ~ 16 线程并发拉取切片；
* **文件重命名模板**：支持 `{title}`（网页标题）、`{host}`（站点域名）、`{date}`（下载日期）等动态占位符。

---

## 📄 免责声明

本扩展仅供合法的个人学习、离线研究及受版权方授权的内容备份使用。请勿将本扩展用于任何侵犯他人知识产权或违反服务条款的商业行为，使用者需自行承担因违规使用产生的法律责任。

---

<p align="center">
  Made with 🧡 by <strong>ZHANGCHAO</strong>
</p>
