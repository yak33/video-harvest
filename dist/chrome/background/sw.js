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
  // tabId -> origin (to reset only when navigating to a different domain)
  const tabOrigins = new Map();
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
      const res = await fetch(url);
      if (!res.ok) return null;
      const text = await res.text();

      if (typeof HLS !== "undefined" && HLS.isMaster(text)) {
        const variants = HLS.parseMaster(text, url);
        let duration = 0;
        // Peek first variant playlist to calculate exact video duration
        if (variants.length > 0) {
          try {
            const vRes = await fetch(variants[0].url);
            if (vRes.ok) {
              const vText = await vRes.text();
              duration = sumExtinfDuration(vText);
            }
          } catch { /* ignore */ }
        }
        return { isMaster: true, variants, duration };
      } else {
        const duration = sumExtinfDuration(text);
        return { isMaster: false, variants: [], duration };
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

      const twMatch = (entry.url || "").match(/(?:amplify_video|ext_tw_video)\/(\d+)/i);
      const twitterMediaId = twMatch ? twMatch[1] : null;

      const results = await scriptingApi.executeScript({
        target: { tabId, allFrames: true },
        args: [twitterMediaId, entry.duration || 0],
        func: (mediaId, expectedDuration) => {
          let poster = "";
          let title = "";
          let tweetUrl = "";

          // --- A. Twitter (X.com) 深度识别：按 mediaId 关联推文与海报 ---
          if (mediaId) {
            const img = document.querySelector(`img[src*="${mediaId}"]`);
            if (img) {
              poster = img.src || "";
              const tweet = img.closest('article[data-testid="tweet"]');
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

          // 若在 Twitter status 详情页且未匹配到卡片，直接提取主推文
          if (!title && (location.hostname.includes("x.com") || location.hostname.includes("twitter.com"))) {
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

          return { poster, title, tweetUrl };
        },
      });

      for (const r of results || []) {
        const data = r?.result;
        if (data) {
          if (data.poster && !entry.thumbnail) entry.thumbnail = data.poster;
          if (data.title && (!entry.pageTitle || entry.pageTitle.includes("主页") || entry.pageTitle === "X")) {
            entry.pageTitle = data.title;
          }
          if (data.tweetUrl && !entry.pageUrl) {
            entry.pageUrl = data.tweetUrl;
          }
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

    const twMatch = (entry.url || "").match(/(?:amplify_video|ext_tw_video)\/(\d+)/i);
    const mediaId = twMatch ? twMatch[1] : null;

    try {
      await scriptingApi.executeScript({
        target: { tabId, allFrames: true },
        args: [mediaId, entry.duration || 0, entry.pageUrl || ""],
        func: (mId, dur, targetUrl) => {
          let targetEl = null;
          if (mId) {
            const img = document.querySelector(`img[src*="${mId}"]`);
            targetEl = img?.closest('article[data-testid="tweet"]') || img;
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

        // 如果是单层媒体清单，但当前标签已有 Master 清单，直接静默丢弃
        if (!hlsInfo.isMaster) {
          const hasMasterInTab = [...map.values()].some((e) => e.variants?.length > 0);
          if (hasMasterInTab) return;
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

        if (hlsInfo.isMaster && hlsInfo.variants && hlsInfo.variants.length > 0) {
          for (const v of hlsInfo.variants) {
            const vNorm = normalizeUrl(v.url);
            knownSubVariants.set(vNorm, entryId);
            if (entry.duration > 0 && v.bandwidth > 0) {
              v.estimatedSize = Math.round((v.bandwidth * entry.duration) / 8);
            }
          }
          if (entry.variants[0]?.estimatedSize) {
            entry.estimatedSize = entry.variants[0].estimatedSize;
          }

          // 清理在此之前可能误入的子流卡片
          for (const [id, e] of map.entries()) {
            if (id === entryId) continue;
            const eNorm = normalizeUrl(e.url);
            const isChild = hlsInfo.variants.some((v) => normalizeUrl(v.url) === eNorm);
            if (isChild || (e.type === "hls" && !e.variants?.length)) {
              map.delete(id);
            }
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
      tabOrigins.delete(tabId);
    });

    // Reset detected media only when navigating to a different website domain
    api.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url) {
        try {
          const newOrigin = new URL(change.url).origin;
          const oldOrigin = tabOrigins.get(tabId);
          if (oldOrigin && oldOrigin !== newOrigin) {
            tabs.delete(tabId);
            updateBadge(tabId);
            notifyPopup();
          }
          tabOrigins.set(tabId, newOrigin);
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


// sw.js — background entry (Chrome MV3 service worker / Firefox MV2 background page).
// In Chrome, engine.js runs in an offscreen document; in Firefox it is co-loaded
// into this persistent background page (see manifest.firefox.json), so we call it
// directly without message round-trips.
/* global chrome, browser, MediaSniffer, EngineAPI */

if (typeof globalThis.browser === "undefined") {
  globalThis.browser = chrome;
}

// Chrome MV3: load sniffer if not already bundled/inlined
if (typeof importScripts === "function" && typeof MediaSniffer === "undefined") {
  try {
    importScripts("sniffer.js");
  } catch (err) {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      importScripts(chrome.runtime.getURL("background/sniffer.js"));
    }
  }
}

MediaSniffer.start();

const OFFSCREEN_URL = (typeof chrome !== "undefined" && chrome.runtime?.getURL)
  ? chrome.runtime.getURL("engine/engine.html")
  : "engine/engine.html";

async function ensureOffscreen() {
  if (!browser.offscreen) return; // Firefox: engine co-loaded
  try {
    const has = await chrome.offscreen.hasDocument?.();
    if (has) return;
  } catch {}
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["BLOBS"],
      justification: "Merging HLS/DASH segments into a downloadable video file",
    });
  } catch (err) {
    if (!String(err?.message || err).includes("Only a single offscreen")) {
      throw err;
    }
  }
}

function sanitize(name) {
  return (name || "video").replace(/[\\/:*?"<>| - ]+/g, " ").trim().slice(0, 80) || "video";
}

async function getSettings() {
  try {
    return await browser.storage.sync.get({ concurrency: 4, nameTpl: "{title}" });
  } catch {
    return { concurrency: 4, nameTpl: "{title}" };
  }
}

function makeFilename(entry, ext, template = "{title}") {
  let host = "unknown";
  try {
    host = new URL(entry.url).hostname;
  } catch { /* ignore */ }
  const title = sanitize(entry.pageTitle || host);
  const date = new Date().toISOString().slice(0, 10);
  let base = template
    .replace(/{title}/g, title)
    .replace(/{host}/g, host)
    .replace(/{date}/g, date);
  base = sanitize(base);
  return `${base}.${ext}`;
}

// --- download filename tracker -------------------------------------------
// Chromium 处理 blob: URL 下载时会将初始文件名覆盖为 blob 路径中的 UUID，
// 必须通过 onDeterminingFilename 统一拦截并强制重命名为实际业务文件名。
// @author ZHANGCHAO 2026/10/17
const pendingFilenamesByUrl = new Map();
const pendingFilenamesById = new Map();

function trackDownloadFilename(url, id, filename) {
  if (url && filename) {
    pendingFilenamesByUrl.set(url, filename);
    setTimeout(() => pendingFilenamesByUrl.delete(url), 120_000);
  }
  if (id && filename) {
    pendingFilenamesById.set(id, filename);
    setTimeout(() => pendingFilenamesById.delete(id), 120_000);
  }
}

const downloadsApi = (typeof browser !== "undefined" && browser.downloads) ? browser.downloads : chrome.downloads;
if (downloadsApi?.onDeterminingFilename) {
  downloadsApi.onDeterminingFilename.addListener((item, suggest) => {
    const desired = pendingFilenamesById.get(item.id) || pendingFilenamesByUrl.get(item.url);
    if (desired) {
      pendingFilenamesById.delete(item.id);
      pendingFilenamesByUrl.delete(item.url);
      suggest({ filename: desired, conflictAction: "uniquify" });
      return true;
    }
  });
}

// --- job execution -------------------------------------------------------

async function startDirectDownload(entry) {
  const cfg = await getSettings();
  const ext = entry.type === "audio"
    ? "mp3"
    : (entry.url.match(/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i)?.[1] || "mp4");
  const filename = makeFilename(entry, ext.toLowerCase(), cfg.nameTpl);
  trackDownloadFilename(entry.url, null, filename);

  const downloadId = await browser.downloads.download({
    url: entry.url,
    filename,
    saveAs: true,
  });
  if (downloadId) {
    trackDownloadFilename(entry.url, downloadId, filename);
  }
  return { ok: true, mode: "direct" };
}

async function startStreamJob(entry, variantUrl) {
  const cfg = await getSettings();
  const chosenVariant = entry.variants?.find((v) => v.url === variantUrl);
  const job = {
    kind: entry.type, // hls | dash
    masterUrl: entry.url, // 始终保留完整的 Master 清单地址，用于音视频分离流提取音频轨
    playlistUrl: variantUrl || entry.url,
    variantUrl: variantUrl,
    audioUrl: chosenVariant?.audioUrl || null,
    referer: entry.referer || entry.url,
    filename: makeFilename(entry, "mp4", cfg.nameTpl),
    concurrency: cfg.concurrency || 4,
  };

  if (typeof EngineAPI !== "undefined") {
    // Firefox: engine co-loaded in this context — call directly.
    return EngineAPI.runJob(job);
  }
  // Chrome: relay to offscreen engine document.
  await ensureOffscreen();
  return browser.runtime.sendMessage({ type: "vh-engine-job", job });
}

// --- message router (supports both Chrome callback and Firefox Promise) ---

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return false;

  switch (msg.type) {
    case "vh-get-media": {
      const list = MediaSniffer.getList(msg.tabId);
      sendResponse(list);
      return false; // synchronous response
    }

    case "vh-clear-media": {
      MediaSniffer.clearTab(msg.tabId);
      sendResponse({ ok: true });
      return false;
    }

    case "vh-locate-media": {
      MediaSniffer.locateMediaInTab(msg.tabId, msg.entry)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // keep channel open for async response
    }

    case "vh-parse-url": {
      MediaSniffer.parseCustomUrl(msg.tabId, msg.url)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // keep channel open for async response
    }

    case "vh-download": {
      const entry = msg.entry;
      const downloadTask = (entry.type === "video" || entry.type === "audio")
        ? startDirectDownload(entry)
        : startStreamJob(entry, msg.variantUrl);

      downloadTask
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // keep channel open for async response
    }

    case "vh-trigger-download": {
      // Chrome MV3: 由 offscreen document 转发而来的 blob URL 下载请求
      trackDownloadFilename(msg.url, null, msg.filename);
      browser.downloads.download({
        url: msg.url,
        filename: msg.filename,
        saveAs: true,
      })
        .then((downloadId) => {
          if (downloadId) trackDownloadFilename(msg.url, downloadId, msg.filename);
          sendResponse({ ok: true, downloadId });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // keep channel open for async response
    }

    case "vh-engine-progress": {
      // relay engine progress to any open popup
      browser.runtime.sendMessage({ ...msg, relayed: true }).catch(() => {});
      return false;
    }

    default:
      return false;
  }
});
