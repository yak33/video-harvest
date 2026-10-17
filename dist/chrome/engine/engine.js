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

  // --- 纯前端 ISO BMFF fMP4 音视频混流工具 ---
  // 用于将独立视频轨道分片与独立音频轨道分片在容器级别无损合并为标准双轨道 MP4 (支持 DASH 与 HLS fMP4)
  // @author ZHANGCHAO 2026/10/17
  function readIsoBoxes(u8) {
    const boxes = [];
    let offset = 0;
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    while (offset + 8 <= u8.byteLength) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]);
      if (size === 0) size = u8.byteLength - offset;
      if (size < 8 || offset + size > u8.byteLength) break;
      boxes.push({ type, offset, size, data: u8.subarray(offset, offset + size) });
      offset += size;
    }
    return boxes;
  }

  function makeIsoBox(type, payload) {
    const size = 8 + payload.byteLength;
    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, size);
    for (let i = 0; i < 4; i++) {
      out[4 + i] = type.charCodeAt(i);
    }
    out.set(payload, 8);
    return out;
  }

  function concatBuffers(bufs) {
    let total = 0;
    for (const b of bufs) total += b.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of bufs) {
      out.set(b, off);
      off += b.byteLength;
    }
    return out;
  }

  function patchTrakTrackId(trakBoxData, newTrackId) {
    const trakData = new Uint8Array(trakBoxData);
    const subBoxes = readIsoBoxes(trakData.subarray(8));
    for (const b of subBoxes) {
      if (b.type === "tkhd") {
        const tkhdOffset = 8 + b.offset;
        const version = trakData[tkhdOffset + 8];
        const trackIdOffset = tkhdOffset + 8 + (version === 0 ? 12 : 20);
        new DataView(trakData.buffer, trakData.byteOffset, trakData.byteLength).setUint32(trackIdOffset, newTrackId);
      }
    }
    return trakData;
  }

  function patchTrexTrackId(trexBoxData, newTrackId) {
    const trexData = new Uint8Array(trexBoxData);
    new DataView(trexData.buffer, trexData.byteOffset, trexData.byteLength).setUint32(12, newTrackId);
    return trexData;
  }

  function patchSegmentMoofTrackId(segmentBuf, newTrackId) {
    const copy = new Uint8Array(segmentBuf);
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    const topBoxes = readIsoBoxes(copy);
    for (const top of topBoxes) {
      if (top.type === "moof") {
        const moofOffset = top.offset;
        const trafBoxes = readIsoBoxes(copy.subarray(moofOffset + 8, moofOffset + top.size));
        for (const traf of trafBoxes) {
          if (traf.type === "traf") {
            const trafOffset = moofOffset + 8 + traf.offset;
            const trafSubs = readIsoBoxes(copy.subarray(trafOffset + 8, trafOffset + traf.size));
            for (const tb of trafSubs) {
              if (tb.type === "tfhd") {
                const tfhdOffset = trafOffset + 8 + tb.offset;
                view.setUint32(tfhdOffset + 12, newTrackId);
              }
            }
          }
        }
      }
    }
    return copy;
  }

  function mergeFmp4(videoParts, audioParts) {
    if (!audioParts || audioParts.length === 0) return videoParts;
    if (!videoParts || videoParts.length === 0) return audioParts;

    const videoInit = new Uint8Array(videoParts[0]);
    const audioInit = new Uint8Array(audioParts[0]);

    const vTopBoxes = readIsoBoxes(videoInit);
    const aTopBoxes = readIsoBoxes(audioInit);

    const vFtyp = vTopBoxes.find((b) => b.type === "ftyp");
    const vMoov = vTopBoxes.find((b) => b.type === "moov");
    const aMoov = aTopBoxes.find((b) => b.type === "moov");

    if (!vMoov || !aMoov) {
      console.warn("Missing moov in init segments, skipping merge");
      return videoParts;
    }

    const vMoovSubs = readIsoBoxes(vMoov.data.subarray(8));
    const vMvhd = vMoovSubs.find((b) => b.type === "mvhd");
    const vTrak = vMoovSubs.find((b) => b.type === "trak");
    const vMvex = vMoovSubs.find((b) => b.type === "mvex");

    const aMoovSubs = readIsoBoxes(aMoov.data.subarray(8));
    const aTrak = aMoovSubs.find((b) => b.type === "trak");
    const aMvex = aMoovSubs.find((b) => b.type === "mvex");

    if (!vTrak || !aTrak) {
      console.warn("Missing trak in moov, skipping merge");
      return videoParts;
    }

    const audioTrackId = 2;
    const patchedAudioTrak = patchTrakTrackId(aTrak.data, audioTrackId);

    const mvexPayloads = [];
    if (vMvex) {
      const vMvexSubs = readIsoBoxes(vMvex.data.subarray(8));
      for (const b of vMvexSubs) {
        if (b.type === "trex") mvexPayloads.push(b.data);
      }
    }
    if (aMvex) {
      const aMvexSubs = readIsoBoxes(aMvex.data.subarray(8));
      for (const b of aMvexSubs) {
        if (b.type === "trex") {
          mvexPayloads.push(patchTrexTrackId(b.data, audioTrackId));
        }
      }
    }
    const mergedMvex = makeIsoBox("mvex", concatBuffers(mvexPayloads));

    let patchedMvhd = vMvhd ? vMvhd.data : new Uint8Array(0);
    if (vMvhd) {
      patchedMvhd = new Uint8Array(vMvhd.data);
      const view = new DataView(patchedMvhd.buffer, patchedMvhd.byteOffset, patchedMvhd.byteLength);
      view.setUint32(patchedMvhd.byteLength - 4, 3); // next_track_ID = 3
    }

    const mergedMoov = makeIsoBox("moov", concatBuffers([
      patchedMvhd,
      vTrak.data,
      patchedAudioTrak,
      mergedMvex,
    ]));

    const mergedInit = concatBuffers([
      vFtyp ? vFtyp.data : new Uint8Array(0),
      mergedMoov,
    ]);

    const vSegs = videoParts.slice(1);
    const aSegs = audioParts.slice(1).map((part) => patchSegmentMoofTrackId(part, audioTrackId));

    const mergedParts = [mergedInit];
    const maxLen = Math.max(vSegs.length, aSegs.length);
    for (let i = 0; i < maxLen; i++) {
      if (i < vSegs.length) mergedParts.push(vSegs[i]);
      if (i < aSegs.length) mergedParts.push(aSegs[i]);
    }
    return mergedParts;
  }

  // 将 MPEG-2 TS 切片在内存中解复用并重封装为标准 ISO BMFF MP4 (ftyp + moov + moof + mdat)
  // @author ZHANGCHAO 2026/10/17
  function transmuxTsToMp4(parts) {
    return new Promise((resolve) => {
      try {
        if (typeof muxjs === "undefined" || !muxjs.mp4?.Transmuxer) {
          return resolve(null);
        }
        const transmuxer = new muxjs.mp4.Transmuxer({
          remux: true,
          keepOriginalTimestamps: true,
        });

        let initSegment = null;
        const dataSegments = [];

        transmuxer.on("data", (segment) => {
          if (segment.initSegment) {
            // 关键优化：优先保留 combined (音视频合并) 的初始化段，避免被单视频初始化段提前锁定
            if (!initSegment || segment.type === "combined" || (initSegment.type !== "combined" && segment.initSegment.byteLength > initSegment.byteLength)) {
              initSegment = segment.initSegment;
              initSegment.type = segment.type;
            }
          }
          if (segment.data) {
            dataSegments.push(segment.data);
          }
        });

        transmuxer.on("done", () => {
          if (!initSegment && dataSegments.length === 0) {
            return resolve(null);
          }
          const combined = [];
          if (initSegment) combined.push(initSegment);
          for (const d of dataSegments) combined.push(d);
          resolve(combined);
        });

        for (const part of parts) {
          const u8 = part instanceof Uint8Array ? part : new Uint8Array(part);
          transmuxer.push(u8);
        }

        transmuxer.flush();
      } catch (err) {
        console.warn("Transmux TS to MP4 failed, fallback to raw segments:", err);
        resolve(null);
      }
    });
  }

  async function runHls(job) {
    report(job.id, { phase: "playlist" });
    let mediaUrl = job.playlistUrl;
    let audioUrl = job.audioUrl || null;

    // 优先从 Master Playlist 中探测匹配的独立音频轨道（解决音视频分离流无声问题）
    const masterCandidateUrl = job.masterUrl || job.playlistUrl;
    try {
      const masterText = await fetchText(masterCandidateUrl);
      if (HLS.isMaster(masterText)) {
        const variants = HLS.parseMaster(masterText, masterCandidateUrl);
        const chosen = job.variantUrl
          ? variants.find((v) => v.url === job.variantUrl) || variants[0]
          : variants[0];
        if (chosen) {
          mediaUrl = chosen.url;
          audioUrl = audioUrl || chosen.audioUrl;
        }
        if (!audioUrl && variants.audioTracks && variants.audioTracks.length > 0) {
          const audio = (chosen?.audioGroup && variants.audioTracks.find((a) => a.groupId === chosen.audioGroup)) || variants.audioTracks[0];
          if (audio && audio.url && audio.url !== mediaUrl) {
            audioUrl = audio.url;
          }
        }
        report(job.id, { phase: "playlist", variant: chosen?.name || "" });
      }
    } catch (err) {
      console.warn("Failed to inspect master playlist for audio:", err);
    }

    const media = HLS.parseMedia(await fetchText(mediaUrl), mediaUrl);
    if (media.isLive) throw new Error("Live streams are not supported yet");
    if (!media.segments.length) throw new Error("No segments in playlist");

    let audioMedia = null;
    if (audioUrl) {
      try {
        const audioText = await fetchText(audioUrl);
        audioMedia = HLS.parseMedia(audioText, audioUrl);
      } catch (err) {
        console.warn("Fetch audio playlist failed, continuing with video only:", err);
      }
    }

    const videoTotal = media.segments.length + (media.initMap ? 1 : 0);
    const audioTotal = audioMedia ? audioMedia.segments.length + (audioMedia.initMap ? 1 : 0) : 0;
    const total = videoTotal + audioTotal;
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

    let audioParts = [];
    if (audioMedia && audioMedia.segments.length > 0) {
      const audioKeyCache = {};
      audioParts = await mapAll(
        audioMedia.segments,
        concurrency,
        async (seg, idx) => {
          const buf = await fetchBuf(seg.url, seg.byteRange, job.referer);
          return maybeDecrypt(buf, audioMedia.key, idx, audioKeyCache);
        },
        () => report(job.id, { phase: "segments", done: ++done, total })
      );
      if (audioMedia.initMap) {
        audioParts.unshift(await fetchBuf(audioMedia.initMap.url, audioMedia.initMap.byteRange, job.referer));
        report(job.id, { phase: "segments", done: ++done, total });
      }
    }

    // 智能格式判断与转封装：
    let finalParts = parts;
    let finalMime = "video/mp4";
    let finalExt = "mp4";

    const isVideoTs = parts.length > 0 && new Uint8Array(parts[0])[0] === 0x47;
    const isAudioTs = audioParts.length > 0 && new Uint8Array(audioParts[0])[0] === 0x47;

    if (isVideoTs) {
      report(job.id, { phase: "transmuxing" });
      if (isAudioTs) {
        // 音视频均为独立 TS 流：分别解复用并重封装为 fMP4，再合并双轨道
        const vMp4 = await transmuxTsToMp4(parts);
        const aMp4 = await transmuxTsToMp4(audioParts);
        if (vMp4 && aMp4) {
          finalParts = mergeFmp4(vMp4, aMp4);
          finalMime = "video/mp4";
          finalExt = "mp4";
        } else {
          finalParts = vMp4 || parts;
          finalMime = vMp4 ? "video/mp4" : "video/mp2t";
          finalExt = vMp4 ? "mp4" : "ts";
        }
      } else {
        // 单 TS 流（音视频已在切片内复合）
        const mp4Parts = await transmuxTsToMp4(parts);
        if (mp4Parts && mp4Parts.length > 0) {
          finalParts = mp4Parts;
          finalMime = "video/mp4";
          finalExt = "mp4";
        } else {
          finalMime = "video/mp2t";
          finalExt = "ts";
        }
      }
    } else {
      // fMP4 (CMAF) 流：若存在独立音频切片，调用 mergeFmp4 混流
      if (audioParts && audioParts.length > 0) {
        report(job.id, { phase: "transmuxing" });
        finalParts = mergeFmp4(parts, audioParts);
      } else {
        finalParts = parts;
      }
      finalMime = "video/mp4";
      finalExt = "mp4";
    }

    await saveBlob(finalParts, finalMime, job.filename.replace(/\.\w+$/, `.${finalExt}`));
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

    // 探测最佳音频 Representation（解决 DASH 流下载无声问题）
    const audioRep = mpd.audioRepresentations && mpd.audioRepresentations.length > 0
      ? mpd.audioRepresentations[0]
      : null;

    let audioInitUrl = null;
    let audioUrls = [];
    if (audioRep) {
      const audioList = DASH.buildSegmentList(audioRep, mpd.duration);
      audioInitUrl = audioList.initUrl;
      audioUrls = audioList.urls;
    }

    const videoTotal = urls.length + (initUrl ? 1 : 0);
    const audioTotal = audioUrls.length + (audioInitUrl ? 1 : 0);
    const total = videoTotal + audioTotal;
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

    let audioParts = [];
    if (audioUrls.length > 0) {
      audioParts = await mapAll(
        audioUrls,
        concurrency,
        (u) => fetchBuf(u, null, job.referer),
        () => report(job.id, { phase: "segments", done: ++done, total })
      );
      if (audioInitUrl) {
        audioParts.unshift(await fetchBuf(audioInitUrl, null, job.referer));
        report(job.id, { phase: "segments", done: ++done, total });
      }
    }

    let finalParts = parts;
    if (audioParts.length > 0) {
      report(job.id, { phase: "transmuxing" });
      finalParts = mergeFmp4(parts, audioParts);
    }

    const ext = rep.mimeType.includes("webm") ? "webm" : "mp4";
    await saveBlob(finalParts, rep.mimeType, job.filename.replace(/\.\w+$/, `.${ext}`));
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
