// sniffer.js — media request detection, fragment filtering, and stream aggregation.
// Exposes: MediaSniffer.start(), shared by Chrome SW and Firefox background page.
/* global browser, chrome, HLS */

const MediaSniffer = (() => {
  const MEDIA_EXT = /\.(mp4|webm|mkv|mov|m4v|flv|avi|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i;
  const HLS_EXT = /\.m3u8(\?|#|$)/i;
  const DASH_EXT = /\.mpd(\?|#|$)/i;

  const CT = {
    hls: ["application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl"],
    dash: ["application/dash+xml"],
    video: ["video/"],
    audio: ["audio/"],
  };

  // Known sub-segments, fragments, or initialization segments to ignore
  const SEGMENT_OR_INIT_EXT = /\.(ts|m4s)(\?|#|$)|(\/|^)init(\.mp4|\.m4s)?(\?|#|$)|(seg|frag|chunk)-\d+/i;

  // tabId -> Map<entryId, entry>
  const tabs = new Map();
  // Map of normalized subVariantUrl -> entryId (to avoid adding child variant m3u8 as standalone videos)
  const knownSubVariants = new Map();
  // tabId -> page key (origin+pathname), X/Twitter切换推文时强制清理媒体池
  const tabPageKeys = new Map();
  // Set of normalized URLs currently in flight being inspected
  const inFlightInspections = new Set();

  const MAX_PER_TAB = 50;

  function normalizeUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname.replace(/\/+$/, "").toLowerCase()}`;
    } catch {
      return (url || "").split("?")[0].replace(/\/+$/, "").toLowerCase();
    }
  }

  // X/Twitter 媒体 ID：同一视频的所有清单（master/视频变体/音频轨道）共享此 ID
  function twMediaIdOf(url) {
    return (url || "").match(/(?:amplify_video|ext_tw_video)\/(\d+)/i)?.[1] || null;
  }

  function classify(url, contentType, resourceType, contentLength) {
    const ct = (contentType || "").toLowerCase();

    // 1. Playlists first
    if (CT.hls.some((p) => ct.includes(p)) || HLS_EXT.test(url) || url.includes(".m3u8")) return "hls";
    if (CT.dash.some((p) => ct.includes(p)) || DASH_EXT.test(url) || url.includes(".mpd")) return "dash";

    // 2. Explicitly exclude segments and initialization chunks
    if (
      ct === "video/mp2t" ||
      ct.includes("iso.segment") ||
      SEGMENT_OR_INIT_EXT.test(url)
    ) {
      return null;
    }

    // 3. Filter out tiny direct media (< 150KB): real standalone videos are never ~800 bytes
    if (contentLength > 0 && contentLength < 150 * 1024) {
      return null;
    }

    // 4. Standalone direct media
    if (CT.video.some((p) => ct.startsWith(p)) || (resourceType === "media" && MEDIA_EXT.test(url)) || MEDIA_EXT.test(url)) {
      return "video";
    }
    if (CT.audio.some((p) => ct.startsWith(p))) {
      return "audio";
    }

    return null;
  }

  function ensureTab(tabId) {
    if (!tabs.has(tabId)) tabs.set(tabId, new Map());
    return tabs.get(tabId);
  }

  let notifyTimer = null;
  function notifyPopup(immediate = false) {
    if (immediate) {
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
      doNotify();
      return;
    }
    if (notifyTimer) clearTimeout(notifyTimer);
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      doNotify();
    }, 60);
  }

  function doNotify() {
    try {
      const api = typeof browser !== "undefined" ? browser : chrome;
      api.runtime.sendMessage({ type: "vh-media-updated" }).catch(() => {});
    } catch {
      /* popup might not be open */
    }
  }

  async function inspectHlsPlaylist(url) {
    try {
      // 优先携带凭据以支持 X 等站点的私有切片探测；若遇 CORS 限制自动平滑降级为普通请求
      // @author ZHANGCHAO 2026/10/17
      let res;
      try {
        res = await fetch(url, { credentials: "include" });
      } catch {
        res = await fetch(url);
      }
      if (!res.ok) {
        res = await fetch(url).catch(() => null);
      }
      if (!res || !res.ok) return null;
      const text = await res.text();

      if (typeof HLS !== "undefined" && HLS.isMaster(text)) {
        const variants = HLS.parseMaster(text, url);
        let duration = 0;
        // Peek first variant playlist to calculate exact video duration
        if (variants.length > 0) {
          try {
            let vRes;
            try {
              vRes = await fetch(variants[0].url, { credentials: "include" });
            } catch {
              vRes = await fetch(variants[0].url);
            }
            if (vRes && vRes.ok) {
              const vText = await vRes.text();
              duration = sumExtinfDuration(vText);
            }
          } catch { /* ignore */ }
        }
        return { isMaster: true, variants, audioTracks: variants.audioTracks || [], duration };
      } else {
        const duration = sumExtinfDuration(text);
        return { isMaster: false, variants: [], audioTracks: [], duration };
      }
    } catch {
      return null;
    }
  }

  function sumExtinfDuration(text) {
    let dur = 0;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith("#EXTINF:")) {
        const val = line.slice(8).split(",")[0].trim();
        dur += parseFloat(val) || 0;
      }
    }
    return Math.round(dur);
  }

  async function enrichWithTabMedia(tabId, entry) {
    if (tabId < 0) return;
    const api = typeof browser !== "undefined" ? browser : chrome;

    // 1. YouTube 页面特殊处理：直接通过 URL 解析 11 位 Video ID，获取官方高清缩略图
    // @author ZHANGCHAO 2026/10/17
    try {
      const tab = await api.tabs.get(tabId);
      const candidateUrl = tab?.url || entry.referer || "";
      if (candidateUrl.includes("youtube.com") || candidateUrl.includes("youtu.be")) {
        const ytMatch = candidateUrl.match(/(?:shorts\/|v=|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
        if (ytMatch && ytMatch[1]) {
          entry.thumbnail = `https://i.ytimg.com/vi/${ytMatch[1]}/hqdefault.jpg`;
        }
      }
    } catch { /* ignore */ }

    // 2. 注入脚本精确定位推文/视频信息（杜绝多视频页面全局 og:image 跨视频污染导致货不对板）
    // @author ZHANGCHAO 2026/10/17
    try {
      const scriptingApi = chrome.scripting || (typeof browser !== "undefined" && browser.scripting);
      if (!scriptingApi) return;

      const twitterMediaId = twMediaIdOf(entry.url);

      const results = await scriptingApi.executeScript({
        target: { tabId, allFrames: true },
        args: [twitterMediaId, entry.duration || 0],
        func: (mediaId, expectedDuration) => {
          let poster = "";
          let title = "";
          let tweetUrl = "";

          // --- A. Twitter (X.com) 深度识别：按 mediaId 关联推文与海报 ---
          // mediaId 是条目 URL 与推文卡片之间唯一的可靠纽带。匹配失败时绝不能
          // 拿主推文冒充，否则推荐流视频全部显示成当前推文的标题和封面（点 A 下 B）。
          // 匹配途径：未播放的封面 img[src] + 已播放的 video[poster]，两者都携带 mediaId
          // @author ZHANGCHAO 2026/10/17
          let mediaIdMatched = false;
          if (mediaId) {
            const img = document.querySelector(`img[src*="${mediaId}"]`);
            const videoEl = img ? null : document.querySelector(`video[poster*="${mediaId}"]`);
            const mediaEl = img || videoEl;
            if (mediaEl) {
              mediaIdMatched = true;
              poster = (img ? img.src : videoEl.poster) || "";
              const tweet = mediaEl.closest('article[data-testid="tweet"]');
              if (tweet) {
                const userEl = tweet.querySelector('div[data-testid="User-Name"]');
                const textEl = tweet.querySelector('div[data-testid="tweetText"]');
                const linkEl = tweet.querySelector('a[href*="/status/"]');
                const user = userEl ? userEl.textContent.replace(/\s+/g, " ").trim() : "";
                const text = textEl ? textEl.textContent.trim() : "";
                if (linkEl?.href) tweetUrl = linkEl.href;
                if (user || text) {
                  title = text ? (user ? `${user}: ${text.slice(0, 45)}` : text.slice(0, 50)) : user;
                }
              }
            }
          }

          // 主推文兜底仅适用于从 URL 中提取不到 mediaId 的 X 条目（如 broadcasts 等特殊流）；
          // 有 mediaId 但未匹配到卡片的条目保持无标题，由弹窗显示 "X 视频 (id尾号)"
          if (!mediaId && !title && (location.hostname.includes("x.com") || location.hostname.includes("twitter.com"))) {
            if (location.pathname.includes("/status/")) {
              const mainTweet = document.querySelector('article[data-testid="tweet"]');
              if (mainTweet) {
                const userEl = mainTweet.querySelector('div[data-testid="User-Name"]');
                const textEl = mainTweet.querySelector('div[data-testid="tweetText"]');
                const user = userEl ? userEl.textContent.replace(/\s+/g, " ").trim() : "";
                const text = textEl ? textEl.textContent.trim() : "";
                if (user || text) {
                  title = text ? (user ? `${user}: ${text.slice(0, 45)}` : text.slice(0, 50)) : user;
                }
              }
              const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
              if (!poster && ogImg && !/logo|favicon/i.test(ogImg)) {
                poster = ogImg;
              }
            }
          }

          // --- B. 通用网页（B站、YouTube、微博等）处理 ---
          if (!poster && !location.hostname.includes("x.com") && !location.hostname.includes("twitter.com")) {
            const videos = Array.from(document.querySelectorAll("video"));
            // 页面有多个视频时，必须按时长严格比对（误差 <= 2秒），禁止随意冒充
            const matchedVideo = expectedDuration > 0
              ? videos.find((v) => Math.abs(v.duration - expectedDuration) <= 2)
              : (videos.find((v) => !v.paused) || (videos.length === 1 ? videos[0] : null));

            if (matchedVideo?.poster) {
              poster = matchedVideo.poster;
            } else if (videos.length === 1) {
              const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute("content") || "";
              if (ogImg && !/yt_1200|logo|favicon|default_thumb/i.test(ogImg)) {
                poster = ogImg;
              }
            }
          }

          let dur = 0;
          if (matchedVideo?.duration) {
            dur = Math.round(matchedVideo.duration);
          }

          return { poster, title, tweetUrl, mediaIdMatched, duration: dur };
        },
      });

      for (const r of results || []) {
        const data = r?.result;
        if (!data) continue;

        if (twitterMediaId) {
          // X 条目：status 页的 tab.title 永远属于主推文，不代表本条目。
          // 拿到匹配推文的标题才写入；任何形式的未命中都清空标题，
          // 让弹窗显示 "X 视频 (id尾号)"，绝不允许主推文文字冒充
          // @author ZHANGCHAO 2026/10/17
          if (data.mediaIdMatched && data.title) {
            entry.pageTitle = data.title;
          } else {
            entry.pageTitle = "";
          }
          if (data.poster && !entry.thumbnail) entry.thumbnail = data.poster;
        } else {
          if (data.poster && !entry.thumbnail) entry.thumbnail = data.poster;
          if (data.title && (!entry.pageTitle || entry.pageTitle.includes("主页") || entry.pageTitle === "X")) {
            entry.pageTitle = data.title;
          }
        }
        if (data.tweetUrl && !entry.pageUrl) {
          entry.pageUrl = data.tweetUrl;
        }
        if (data.duration && !entry.duration) {
          entry.duration = data.duration;
        }
      }
    } catch {
      /* ignore permission or restricted URL errors */
    }
  }

  // 在网页中高亮平滑滚动到对应的视频或推文元素
  // @author ZHANGCHAO 2026/10/17
  async function locateMediaInTab(tabId, entry) {
    if (!tabId || tabId < 0 || !entry) return { ok: false };
    const scriptingApi = chrome.scripting || (typeof browser !== "undefined" && browser.scripting);
    if (!scriptingApi) return { ok: false };

    const mediaId = twMediaIdOf(entry.url);

    try {
      await scriptingApi.executeScript({
        target: { tabId, allFrames: true },
        args: [mediaId, entry.duration || 0, entry.pageUrl || ""],
        func: (mId, dur, targetUrl) => {
          let targetEl = null;
          if (mId) {
            // 同 enrichWithTabMedia：封面 img 与已播放 video[poster] 双途径定位
            const img = document.querySelector(`img[src*="${mId}"]`);
            const videoEl = img ? null : document.querySelector(`video[poster*="${mId}"]`);
            const mediaEl = img || videoEl;
            targetEl = mediaEl?.closest('article[data-testid="tweet"]') || mediaEl;
          }
          if (!targetEl && targetUrl) {
            try {
              const path = new URL(targetUrl).pathname;
              const link = document.querySelector(`a[href*="${path}"]`);
              targetEl = link?.closest('article[data-testid="tweet"]') || link;
            } catch {}
          }
          if (!targetEl && dur > 0) {
            const videos = Array.from(document.querySelectorAll("video"));
            targetEl = videos.find((v) => Math.abs(v.duration - dur) <= 2);
          }
          if (!targetEl) {
            const videos = Array.from(document.querySelectorAll("video"));
            targetEl = videos.find((v) => !v.paused) || videos[0];
          }

          if (targetEl) {
            targetEl.scrollIntoView({ behavior: "smooth", block: "center" });
            const origOutline = targetEl.style.outline;
            const origTransition = targetEl.style.transition;
            targetEl.style.transition = "outline 0.2s ease-in-out";
            targetEl.style.outline = "4px solid #ea580c";
            setTimeout(() => {
              targetEl.style.outline = origOutline;
              targetEl.style.transition = origTransition;
            }, 2500);
            return true;
          }
          return false;
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  async function addEntry(tabId, info) {
    const api = typeof browser !== "undefined" ? browser : chrome;

    // If tabId is negative (e.g. background request not tied to a tab), associate with current active tab
    if (tabId < 0) {
      // If this request was made by the extension background/offscreen, ignore!
      if (info.referer && (info.referer.startsWith("chrome-extension://") || info.referer.startsWith("moz-extension://"))) {
        return;
      }
      try {
        const tabsList = await api.tabs.query({ active: true, currentWindow: true });
        if (tabsList && tabsList[0]?.id) {
          tabId = tabsList[0].id;
        } else {
          return;
        }
      } catch {
        return;
      }
    }

    const map = ensureTab(tabId);
    const normUrl = normalizeUrl(info.url);

    // 1. Normalized URL deduplication: avoid adding the same playlist or video file repeatedly
    for (const existing of map.values()) {
      if (normalizeUrl(existing.url) === normUrl) {
        return;
      }
    }

    // 2. If this URL was already registered as a child variant of an existing Master Playlist, do not add as standalone video
    if (info.type === "hls" && knownSubVariants.has(normUrl)) {
      return;
    }

    // 3. If this URL is already being inspected in flight, do not start another inspection
    if (inFlightInspections.has(normUrl)) {
      return;
    }

    // 4. If any existing Master Playlist in this tab already contains this variant, do not add
    for (const existing of map.values()) {
      if (existing.variants?.some((v) => normalizeUrl(v.url) === normUrl)) {
        return;
      }
    }

    // Capacity limit: FIFO remove oldest
    if (map.size >= MAX_PER_TAB) {
      const oldestKey = map.keys().next().value;
      if (oldestKey) map.delete(oldestKey);
    }

    // --- HLS 专用处理流：先异步拉取判定清单类型，过滤子流后再上屏，避免临时卡片闪烁 ---
    if (info.type === "hls") {
      inFlightInspections.add(normUrl);
      try {
        const hlsInfo = await inspectHlsPlaylist(info.url);
        if (!hlsInfo) return;

        // 再次检查（拉取期间可能有其他请求完成并已入库）
        for (const existing of map.values()) {
          if (normalizeUrl(existing.url) === normUrl) return;
        }
        if (knownSubVariants.has(normUrl)) return;
        for (const existing of map.values()) {
          if (existing.variants?.some((v) => normalizeUrl(v.url) === normUrl)) return;
        }

        // 同一 X 视频已存在 master 条目时，本单层清单必为其分离的音/视频子流，
        // 独立入库只会产生"下载后只有画面/只有声音"的残缺条目
        // @author ZHANGCHAO 2026/10/17
        const myTwId = twMediaIdOf(info.url);
        const iAmMaster = hlsInfo.isMaster && hlsInfo.variants && hlsInfo.variants.length > 0;
        if (myTwId && !iAmMaster) {
          for (const existing of map.values()) {
            if (existing.type === "hls" && existing.variants?.length && twMediaIdOf(existing.url) === myTwId) {
              return;
            }
          }
        }

        const entryId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const entry = {
          id: entryId,
          url: info.url,
          type: "hls",
          contentType: info.contentType || "",
          size: 0,
          estimatedSize: 0,
          duration: hlsInfo.duration || 0,
          thumbnail: "",
          referer: info.referer || "",
          origin: info.origin || "",
          pageTitle: info.pageTitle || "",
          favIconUrl: info.favIconUrl || "",
          variants: hlsInfo.variants || [],
          foundAt: Date.now(),
        };

        if (iAmMaster) {
          for (const v of hlsInfo.variants) {
            const vNorm = normalizeUrl(v.url);
            knownSubVariants.set(vNorm, entryId);
            if (entry.duration > 0 && v.bandwidth > 0) {
              v.estimatedSize = Math.round((v.bandwidth * entry.duration) / 8);
            }
          }
          // 独立音频轨道清单同样注册为子流：X 的视频变体不含音轨，
          // 音频清单若独立入库，下载后只有声音没有画面
          // @author ZHANGCHAO 2026/10/17
          for (const a of hlsInfo.audioTracks || []) {
            knownSubVariants.set(normalizeUrl(a.url), entryId);
          }
          if (entry.variants[0]?.estimatedSize) {
            entry.estimatedSize = entry.variants[0].estimatedSize;
          }

          // 清理先于 master 入库的子流卡片：视频变体、音频轨道，以及同 mediaId 的
          // 其他 HLS 清单（URL 可能因重定向/参数差异与 master 内容对不上，按 mediaId 兜底）
          // @author ZHANGCHAO 2026/10/17
          const childUrls = new Set(hlsInfo.variants.map((v) => normalizeUrl(v.url)));
          for (const a of hlsInfo.audioTracks || []) {
            childUrls.add(normalizeUrl(a.url));
          }
          for (const [id, e] of map.entries()) {
            if (id === entryId) continue;
            const isChild = childUrls.has(normalizeUrl(e.url));
            const sameTwMedia = myTwId && e.type === "hls" && twMediaIdOf(e.url) === myTwId;
            if (isChild || sameTwMedia) map.delete(id);
          }
        }

        map.set(entryId, entry);
        updateBadge(tabId);
        notifyPopup();

        try {
          const tab = await api.tabs.get(tabId);
          entry.pageTitle = tab.title || "";
          entry.favIconUrl = tab.favIconUrl || "";
        } catch {}

        enrichWithTabMedia(tabId, entry).finally(() => {
          if (entry.duration > 0 && entry.variants?.length > 0) {
            for (const v of entry.variants) {
              if (v.bandwidth > 0) {
                v.estimatedSize = Math.round((v.bandwidth * entry.duration) / 8);
              }
            }
            if (entry.variants[0]?.estimatedSize) {
              entry.estimatedSize = entry.variants[0].estimatedSize;
            }
          }
          updateBadge(tabId);
          notifyPopup();
        });
      } finally {
        inFlightInspections.delete(normUrl);
      }
      return;
    }

    // --- 普通媒体（video, audio, dash）处理流 ---
    const entryId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry = {
      id: entryId,
      url: info.url,
      type: info.type,
      contentType: info.contentType || "",
      size: info.type === "dash" ? 0 : (info.size || 0),
      estimatedSize: 0,
      duration: 0,
      thumbnail: "",
      referer: info.referer || "",
      origin: info.origin || "",
      pageTitle: info.pageTitle || "",
      favIconUrl: info.favIconUrl || "",
      variants: [],
      foundAt: Date.now(),
    };

    map.set(entryId, entry);
    updateBadge(tabId);
    notifyPopup();

    try {
      const tab = await api.tabs.get(tabId);
      entry.pageTitle = tab.title || "";
      entry.favIconUrl = tab.favIconUrl || "";
    } catch {}

    enrichWithTabMedia(tabId, entry).finally(() => {
      updateBadge(tabId);
      notifyPopup();
    });
  }

  function updateBadge(tabId) {
    const n = tabs.get(tabId)?.size || 0;
    const api = typeof browser !== "undefined" ? browser : chrome;
    const actionApi = api.action || api.browserAction;
    if (!actionApi) return;
    actionApi.setBadgeText({ tabId, text: n ? String(n) : "" });
    actionApi.setBadgeBackgroundColor({ tabId, color: "#e8590c" });
  }

  function getList(tabId) {
    return [...(tabs.get(tabId)?.values() || [])].sort((a, b) => b.foundAt - a.foundAt);
  }

  function clearTab(tabId) {
    tabs.delete(tabId);
    updateBadge(tabId);
    notifyPopup();
  }

  function start() {
    const api = typeof browser !== "undefined" ? browser : chrome;

    api.webRequest.onHeadersReceived.addListener(
      (details) => {
        // 关键防护：严格过滤掉由扩展本身发起的抓取与解密请求，防止自循环递归嗅探
        const initiator = details.initiator || details.originUrl || details.documentUrl || "";
        if (
          initiator.startsWith("chrome-extension://") ||
          initiator.startsWith("moz-extension://")
        ) {
          return;
        }

        const hdr = (name) => {
          const h = details.responseHeaders?.find((x) => x.name.toLowerCase() === name);
          return h?.value || "";
        };
        const size = parseInt(hdr("content-length"), 10) || 0;
        const type = classify(details.url, hdr("content-type"), details.type, size);
        if (!type) return;

        addEntry(details.tabId, {
          url: details.url,
          type,
          contentType: hdr("content-type"),
          size,
          origin: hdr("origin"),
          referer: initiator,
        });
      },
      { urls: ["<all_urls>"] },
      ["responseHeaders"]
    );

    api.tabs.onRemoved.addListener((tabId) => {
      tabs.delete(tabId);
      tabPageKeys.delete(tabId);
    });

    // 页面切换即清池：跨站导航或同站 SPA 路由变化（如 X 切换推文）都算换页。
    // 旧页面的媒体条目若继续留在列表，其标题/封面会与新页面内容互相冒充，导致"点 A 下 B"
    // @author ZHANGCHAO 2026/10/17
    api.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url) {
        try {
          const u = new URL(change.url);
          const pageKey = `${u.origin}${u.pathname}`;
          const oldKey = tabPageKeys.get(tabId);
          if (oldKey && oldKey !== pageKey) {
            tabs.delete(tabId);
            updateBadge(tabId);
            notifyPopup();
          }
          tabPageKeys.set(tabId, pageKey);
        } catch {}
      }
    });
  }

  // 手动输入视频地址解析：同时支持流媒体直链与网页播放地址嗅探
  // @author ZHANGCHAO 2026/10/17
  async function parseCustomUrl(targetTabId, inputUrl) {
    const api = typeof browser !== "undefined" ? browser : chrome;
    if (!targetTabId) {
      const [curTab] = await api.tabs.query({ active: true, currentWindow: true });
      targetTabId = curTab?.id;
    }

    // 1. 尝试直接判断是否为媒体直链（HLS, DASH, Direct Video/Audio）
    let directType = classify(inputUrl, "", "", 0);

    // 若无法仅靠 URL 扩展名判定，发起轻量级探测以读取 Content-Type
    let contentType = "";
    let contentLength = 0;
    if (!directType) {
      try {
        const headRes = await fetch(inputUrl, { method: "HEAD", credentials: "omit" }).catch(() => null);
        if (headRes && headRes.ok) {
          contentType = headRes.headers.get("content-type") || "";
          contentLength = parseInt(headRes.headers.get("content-length"), 10) || 0;
          directType = classify(inputUrl, contentType, "", contentLength);
        }
      } catch { /* ignore network error */ }
    }

    // --- 路径 A：直链流媒体 / 文件直接入库 ---
    if (directType) {
      await addEntry(targetTabId, {
        url: inputUrl,
        type: directType,
        contentType,
        size: contentLength,
        referer: inputUrl,
      });
      notifyPopup(true);
      return { ok: true, mode: "direct", type: directType };
    }

    // --- 路径 B：普通网页播放页，启动后台静默标签页嗅探 ---
    let tempTab = null;
    try {
      tempTab = await api.tabs.create({ url: inputUrl, active: false });
    } catch (err) {
      throw new Error(`无法打开后台标签页进行嗅探: ${err.message || err}`);
    }

    const tempTabId = tempTab.id;
    const initialCount = tabs.get(tempTabId)?.size || 0;

    // 尝试在页面加载后执行静默播放触发请求
    const triggerPlayScript = () => {
      try {
        const scriptingApi = chrome.scripting || (typeof browser !== "undefined" && browser.scripting);
        if (scriptingApi) {
          scriptingApi.executeScript({
            target: { tabId: tempTabId, allFrames: true },
            func: () => {
              document.querySelectorAll("video, audio").forEach((el) => {
                try { el.muted = true; el.play(); } catch {}
              });
            },
          }).catch(() => {});
        }
      } catch {}
    };

    // 轮询检查该临时标签页是否捕获到了媒体资源（最多等待 15 秒）
    const startTime = Date.now();
    let captured = [];

    try {
      while (Date.now() - startTime < 15000) {
        await new Promise((r) => setTimeout(r, 600));

        // 每隔 2 秒尝试触发页面内 video 播放
        if ((Date.now() - startTime) % 2000 < 600) {
          triggerPlayScript();
        }

        const currentMap = tabs.get(tempTabId);
        if (currentMap && currentMap.size > initialCount) {
          captured = [...currentMap.values()];
          break;
        }
      }

      if (!captured.length) {
        throw new Error("在目标网页中未检测到视频媒体请求，建议直接访问网页并播放视频后再打开插件");
      }

      // 将嗅探到的条目迁移/挂载到当前主标签页
      const targetMap = ensureTab(targetTabId);
      for (const item of captured) {
        if (!item.pageTitle || item.pageTitle.includes("主页") || item.pageTitle === "X") {
          try {
            const parsed = new URL(inputUrl);
            item.pageTitle = `${parsed.hostname}${parsed.pathname}`;
          } catch {}
        }
        if (!item.pageUrl) {
          item.pageUrl = inputUrl;
        }
        targetMap.set(item.id, item);
      }
      updateBadge(targetTabId);
      notifyPopup(true);

      return { ok: true, mode: "page_sniffed", count: captured.length };
    } finally {
      // 无论成功还是超时，必须安全关闭后台静默标签页
      try {
        await api.tabs.remove(tempTabId);
        tabs.delete(tempTabId);
      } catch {}
    }
  }

  return { start, getList, clearTab, classify, parseCustomUrl, locateMediaInTab };
})();

if (typeof module !== "undefined") module.exports = MediaSniffer;

