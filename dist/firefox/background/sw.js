// sw.js — background entry (Chrome MV3 service worker / Firefox MV2 background page).
// In Chrome, engine.js runs in an offscreen document; in Firefox it is co-loaded
// into this persistent background page (see manifest.firefox.json), so we call it
// directly without message round-trips.
/* global chrome, browser, MediaSniffer, EngineAPI */

if (typeof globalThis.browser === "undefined") {
  globalThis.browser = chrome;
}

// Chrome MV3: load deps into the service worker.
// Note: importScripts resolves relative to sw.js location (/background/),
// so we must use absolute extension paths (/lib/..., /background/...).
if (typeof importScripts === "function" && typeof MediaSniffer === "undefined") {
  importScripts("/lib/url-util.js", "/engine/hls.js", "/background/sniffer.js");
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

// --- job execution -------------------------------------------------------

async function startDirectDownload(entry) {
  const cfg = await getSettings();
  const ext = entry.type === "audio"
    ? "mp3"
    : (entry.url.match(/\.(mp4|webm|mkv|mov|m4v|mp3|m4a|aac|ogg|opus|wav)(\?|#|$)/i)?.[1] || "mp4");

  await browser.downloads.download({
    url: entry.url,
    filename: makeFilename(entry, ext.toLowerCase(), cfg.nameTpl),
    saveAs: true,
  });
  return { ok: true, mode: "direct" };
}

async function startStreamJob(entry, variantUrl) {
  const cfg = await getSettings();
  const job = {
    kind: entry.type, // hls | dash
    playlistUrl: variantUrl || entry.url,
    variantUrl: variantUrl,
    referer: entry.referer || entry.url,
    filename: makeFilename(entry, entry.type === "hls" ? "mp4" : "mp4", cfg.nameTpl),
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
      browser.downloads.download({
        url: msg.url,
        filename: msg.filename,
        saveAs: true,
      })
        .then((downloadId) => sendResponse({ ok: true, downloadId }))
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
