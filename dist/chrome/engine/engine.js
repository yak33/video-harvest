// engine.js — stream download engine. Runs in the Chrome offscreen document
// (engine/engine.html) or co-loaded into the Firefox persistent background page.
// Exposes global EngineAPI.runJob(job) and answers 'vh-engine-job' messages.
/* global chrome, browser, HLS, DASH */

if (typeof globalThis.browser === "undefined") {
  globalThis.browser = chrome;
}

const EngineAPI = (() => {
  function report(id, payload) {
    browser.runtime.sendMessage({ type: "vh-engine-progress", id, ...payload }).catch(() => {});
  }

  async function fetchBuf(url, byteRange, referer) {
    const headers = {};
    if (byteRange) {
      headers["Range"] = `bytes=${byteRange.offset}-${byteRange.end}`;
    }
    const res = await fetch(url, { headers, credentials: "include" });
    if (!res.ok && res.status !== 206) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }
    return res.arrayBuffer();
  }

  async function fetchText(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }

  // concurrency-limited map preserving order
  async function mapAll(items, limit, fn, onEach) {
    const out = new Array(items.length);
    let i = 0;
    const concurrency = Math.max(1, limit || 4);
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
        onEach?.(idx);
      }
    });
    await Promise.all(workers);
    return out;
  }

  async function maybeDecrypt(buf, keyInfo, seq, keyCache) {
    if (!keyInfo || keyInfo.method !== "AES-128") return buf;
    if (!keyCache.key) {
      const raw = await fetchBuf(keyInfo.url);
      keyCache.key = await crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, ["decrypt"]);
    }
    let iv;
    if (keyInfo.iv) {
      const hex = keyInfo.iv.replace(/^0x/i, "");
      iv = new Uint8Array(hex.match(/../g).map((b) => parseInt(b, 16)));
    } else {
      iv = new Uint8Array(16);
      new DataView(iv.buffer).setUint32(12, seq, false); // big-endian media sequence
    }
    try {
      return await crypto.subtle.decrypt({ name: "AES-CBC", iv }, keyCache.key, buf);
    } catch (err) {
      console.warn("AES-CBC decrypt error (possibly non-PKCS7 unpadded segment):", err);
      return buf;
    }
  }

  async function runHls(job) {
    report(job.id, { phase: "playlist" });
    const text = await fetchText(job.playlistUrl);
    let mediaUrl = job.playlistUrl;

    if (HLS.isMaster(text)) {
      const variants = HLS.parseMaster(text, job.playlistUrl);
      if (!variants.length) throw new Error("Empty master playlist");
      const chosen = job.variantUrl
        ? variants.find((v) => v.url === job.variantUrl) || variants[0]
        : variants[0];
      mediaUrl = chosen.url;
      report(job.id, { phase: "playlist", variant: chosen.name });
    }

    const media = HLS.parseMedia(await fetchText(mediaUrl), mediaUrl);
    if (media.isLive) throw new Error("Live streams are not supported yet");
    if (!media.segments.length) throw new Error("No segments in playlist");

    const total = media.segments.length + (media.initMap ? 1 : 0);
    let done = 0;
    const keyCache = {};
    const concurrency = job.concurrency || 4;

    const parts = await mapAll(
      media.segments,
      concurrency,
      async (seg, idx) => {
        const buf = await fetchBuf(seg.url, seg.byteRange, job.referer);
        return maybeDecrypt(buf, media.key, idx, keyCache);
      },
      () => report(job.id, { phase: "segments", done: ++done, total })
    );

    if (media.initMap) {
      parts.unshift(await fetchBuf(media.initMap.url, media.initMap.byteRange, job.referer));
      report(job.id, { phase: "segments", done: ++done, total });
    }

    const mime = media.initMap ? "video/mp4" : "video/mp2t";
    const ext = media.initMap ? "mp4" : "ts";
    await saveBlob(parts, mime, job.filename.replace(/\.\w+$/, `.${ext}`));
    return { ok: true, mode: "hls", segments: media.segments.length };
  }

  async function runDash(job) {
    report(job.id, { phase: "playlist" });
    const mpd = DASH.parseMpd(await fetchText(job.playlistUrl), job.playlistUrl);
    if (!mpd.representations.length) throw new Error("No video representations in MPD");

    const rep = job.variantUrl
      ? mpd.representations.find((r) => r.id === job.variantUrl) || mpd.representations[0]
      : mpd.representations[0];
    report(job.id, { phase: "playlist", variant: rep.name });

    const { initUrl, urls } = DASH.buildSegmentList(rep, mpd.duration);
    if (!urls.length) throw new Error("Could not expand segment list");

    const total = urls.length + (initUrl ? 1 : 0);
    let done = 0;
    const concurrency = job.concurrency || 4;

    const parts = await mapAll(
      urls,
      concurrency,
      (u) => fetchBuf(u, null, job.referer),
      () => report(job.id, { phase: "segments", done: ++done, total })
    );
    if (initUrl) {
      parts.unshift(await fetchBuf(initUrl, null, job.referer));
      report(job.id, { phase: "segments", done: ++done, total });
    }

    const ext = rep.mimeType.includes("webm") ? "webm" : "mp4";
    await saveBlob(parts, rep.mimeType, job.filename.replace(/\.\w+$/, `.${ext}`));
    return { ok: true, mode: "dash", segments: urls.length };
  }

  async function saveBlob(parts, mime, filename) {
    const blob = new Blob(parts, { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      // 1. 如果当前上下文具备 downloads API（如 Firefox persistent background page），直接调用
      if (typeof browser !== "undefined" && browser.downloads?.download) {
        await browser.downloads.download({ url, filename, saveAs: true });
        return;
      }
      if (typeof chrome !== "undefined" && chrome.downloads?.download) {
        await chrome.downloads.download({ url, filename, saveAs: true });
        return;
      }

      // 2. Chrome MV3: engine 运行在 offscreen document 中，无 chrome.downloads 权限
      // 转发至具备 downloads 权限的 background service worker 处理
      const res = await (typeof browser !== "undefined" ? browser : chrome).runtime.sendMessage({
        type: "vh-trigger-download",
        url,
        filename,
      });

      if (!res || res.ok === false) {
        // 后台下载失败时降级：尝试使用 offscreen DOM 的 <a> 标签触发下载
        try {
          const a = document.createElement("a");
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => a.remove(), 1000);
        } catch (anchorErr) {
          throw new Error(res?.error || anchorErr?.message || "触发下载失败");
        }
      }
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  async function runJob(job) {
    job.id = job.id || `job-${Date.now().toString(36)}`;
    try {
      const result = job.kind === "hls" ? await runHls(job) : await runDash(job);
      report(job.id, { phase: "done", result });
      return result;
    } catch (err) {
      report(job.id, { phase: "error", error: String(err?.message || err) });
      throw err;
    }
  }

  return { runJob };
})();

// Chrome offscreen path: background relays jobs via runtime messages.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "vh-engine-job") {
    EngineAPI.runJob(msg.job)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true; // asynchronous response
  }
  return false;
});
