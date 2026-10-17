// sw.js — background entry (Chrome MV3 service worker / Firefox MV2 background page).
// In Chrome, engine.js runs in an offscreen document; in Firefox it is co-loaded
// into this persistent background page (see manifest.firefox.json), so we call it
// directly without message round-trips.
/* global chrome, browser, MediaSniffer, EngineAPI */

if (typeof globalThis.browser === "undefined") {
  globalThis.browser = chrome;
}

// Chrome MV3: load deps if not already bundled/inlined
if (typeof importScripts === "function") {
  if (typeof HLS === "undefined") {
    try {
      importScripts("../engine/hls.js");
    } catch {
      if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        try { importScripts(chrome.runtime.getURL("engine/hls.js")); } catch {}
      }
    }
  }
  if (typeof MediaSniffer === "undefined") {
    try {
      importScripts("sniffer.js");
    } catch {
      if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        try { importScripts(chrome.runtime.getURL("background/sniffer.js")); } catch {}
      }
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
  // 标题缺失时（如 X 上匹配不到推文的条目）必须拼上 URL 特征（X 用 mediaId 尾号），
  // 否则同站所有视频下载后文件同名，用户无法分辨哪个是哪个。
  // 注意 sanitize("") 会返回 "video"，必须先判空再 sanitize
  // @author ZHANGCHAO 2026/10/17
  let title = entry.pageTitle ? sanitize(entry.pageTitle) : "";
  if (!title) {
    const twMatch = (entry.url || "").match(/(?:amplify_video|ext_tw_video)\/(\d+)/i);
    const tail = twMatch
      ? twMatch[1].slice(-10)
      : ((entry.url || "").split("/").pop() || "").split("?")[0].replace(/\.\w{1,5}$/, "").slice(0, 20);
    title = `${host} ${tail}`.trim() || host;
  }
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

// entryId -> { entryId, phase, done, total, percent, updatedAt }
const activeDownloadJobs = new Map();

async function startDirectDownload(entry) {
  const cfg = await getSettings();
  const ext = entry.type === "audio"
    ? "mp3"
    : (entry.url.match(/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i)?.[1] || "mp4");
  const filename = makeFilename(entry, ext.toLowerCase(), cfg.nameTpl);
  trackDownloadFilename(entry.url, null, filename);

  activeDownloadJobs.set(entry.id, {
    entryId: entry.id,
    phase: "starting",
    done: 0,
    total: 0,
    percent: 0,
    updatedAt: Date.now(),
  });

  try {
    const downloadId = await browser.downloads.download({
      url: entry.url,
      filename,
      saveAs: true,
    });
    if (downloadId) {
      trackDownloadFilename(entry.url, downloadId, filename);
      activeDownloadJobs.set(entry.id, {
        entryId: entry.id,
        phase: "done",
        done: 1,
        total: 1,
        percent: 100,
        updatedAt: Date.now(),
      });
      setTimeout(() => activeDownloadJobs.delete(entry.id), 2500);
    }
    return { ok: true, mode: "direct" };
  } catch (err) {
    activeDownloadJobs.delete(entry.id);
    throw err;
  }
}

async function startStreamJob(entry, variantUrl) {
  const cfg = await getSettings();
  const chosenVariant = entry.variants?.find((v) => v.url === variantUrl);
  const jobId = `job-${entry.id}`;
  const job = {
    id: jobId,
    entryId: entry.id,
    kind: entry.type, // hls | dash
    masterUrl: entry.url, // 始终保留完整的 Master 清单地址，用于音视频分离流提取音频轨
    playlistUrl: variantUrl || entry.url,
    variantUrl: variantUrl,
    audioUrl: chosenVariant?.audioUrl || null,
    referer: entry.referer || entry.url,
    filename: makeFilename(entry, "mp4", cfg.nameTpl),
    concurrency: cfg.concurrency || 4,
  };

  activeDownloadJobs.set(entry.id, {
    entryId: entry.id,
    phase: "starting",
    done: 0,
    total: 0,
    percent: 0,
    updatedAt: Date.now(),
  });

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
      const downloadStates = {};
      for (const [k, v] of activeDownloadJobs.entries()) {
        downloadStates[k] = v;
      }
      sendResponse({ media: list, downloadStates });
      return false; // synchronous response
    }

    case "vh-clear-media": {
      MediaSniffer.clearTab(msg.tabId);
      sendResponse({ ok: true });
      return false; // synchronous response
    }

    case "vh-rescan-media": {
      MediaSniffer.rescanTab(msg.tabId)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true; // keep channel open for async response
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
        .catch((err) => {
          activeDownloadJobs.delete(entry.id);
          sendResponse({ ok: false, error: String(err?.message || err) });
        });
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
      const entryId = msg.entryId || (msg.id ? String(msg.id).replace(/^job-/, "") : null);
      if (entryId) {
        if (msg.phase === "done") {
          activeDownloadJobs.set(entryId, {
            entryId,
            phase: "done",
            done: msg.total || 1,
            total: msg.total || 1,
            percent: 100,
            updatedAt: Date.now(),
          });
          setTimeout(() => activeDownloadJobs.delete(entryId), 3000);
        } else if (msg.phase === "error") {
          activeDownloadJobs.set(entryId, {
            entryId,
            phase: "error",
            error: msg.error,
            percent: 0,
            updatedAt: Date.now(),
          });
          setTimeout(() => activeDownloadJobs.delete(entryId), 5000);
        } else {
          const total = msg.total || 0;
          const done = msg.done || 0;
          const percent = total > 0 ? Math.round((done / total) * 100) : (msg.phase === "transmuxing" ? 100 : 0);
          activeDownloadJobs.set(entryId, {
            entryId,
            phase: msg.phase,
            done,
            total,
            percent,
            updatedAt: Date.now(),
          });
        }
      }
      // relay engine progress to any open popup
      browser.runtime.sendMessage({ ...msg, entryId, relayed: true }).catch(() => {});
      return false;
    }

    default:
      return false;
  }
});
