// hls.js — minimal HLS parser (master + media playlists, AES-128 key info, byte-range).
/* global module */

const HLS = (() => {
  function parseAttributes(line) {
    const attrs = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) attrs[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return attrs;
  }

  function isMaster(text) {
    return /#EXT-X-STREAM-INF/.test(text);
  }

  function resolveUri(uri, baseUrl) {
    try {
      const resolved = new URL(uri.trim(), baseUrl);
      const base = new URL(baseUrl);
      if (!resolved.search && base.search) {
        resolved.search = base.search;
      }
      return resolved.href;
    } catch {
      return uri.trim();
    }
  }

  // -> variants array with attached audioTracks: [{ url, bandwidth, width, height, codecs, name }]
  function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    const audioTracks = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = parseAttributes(line.slice(18));
        const uri = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
        if (!uri) continue;
        const [w, h] = (attrs["RESOLUTION"] || "x").split("x").map((n) => parseInt(n, 10) || 0);
        variants.push({
          url: resolveUri(uri, baseUrl),
          bandwidth: parseInt(attrs["BANDWIDTH"], 10) || 0,
          width: w,
          height: h,
          codecs: attrs["CODECS"] || "",
          audioGroup: attrs["AUDIO"] || "",
          name: h ? `${h}p` : `${Math.round((parseInt(attrs["BANDWIDTH"], 10) || 0) / 1000)}kbps`,
        });
      } else if (line.startsWith("#EXT-X-MEDIA:")) {
        const attrs = parseAttributes(line.slice(13));
        if (attrs["TYPE"] === "AUDIO" && attrs["URI"]) {
          audioTracks.push({
            groupId: attrs["GROUP-ID"] || "",
            name: attrs["NAME"] || "audio",
            url: new URL(attrs["URI"], baseUrl).href,
          });
        }
      }
    }
    variants.sort((a, b) => b.bandwidth - a.bandwidth);
    variants.audioTracks = audioTracks;
    return variants;
  }

  // -> { segments: [{url, duration, byteRange}], key: {method,url,iv}|null, initMap: {url, byteRange}|null, isLive }
  function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let key = null;
    let initMap = null;
    let duration = 0;
    let isLive = !/#EXT-X-ENDLIST/.test(text);
    let currentByteRange = null;
    let lastByteEnd = 0;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("#EXTINF:")) {
        duration = parseFloat(line.slice(8)) || 0;
      } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
        const val = line.slice(17).trim();
        const [lenStr, offStr] = val.split("@");
        const length = parseInt(lenStr, 10);
        const offset = offStr !== undefined ? parseInt(offStr, 10) : lastByteEnd;
        currentByteRange = { offset, length, end: offset + length - 1 };
        lastByteEnd = offset + length;
      } else if (line.startsWith("#EXT-X-KEY:")) {
        const a = parseAttributes(line.slice(11));
        if (a.METHOD && a.METHOD !== "NONE") {
          key = {
            method: a.METHOD,
            url: a.URI ? new URL(a.URI, baseUrl).href : null,
            iv: a.IV || null,
          };
        }
      } else if (line.startsWith("#EXT-X-MAP:")) {
        const a = parseAttributes(line.slice(11));
        let mapByteRange = null;
        if (a["BYTERANGE"]) {
          const [mLen, mOff] = a["BYTERANGE"].split("@");
          const l = parseInt(mLen, 10);
          const o = mOff !== undefined ? parseInt(mOff, 10) : 0;
          mapByteRange = { offset: o, length: l, end: o + l - 1 };
        }
        if (a.URI) initMap = { url: new URL(a.URI, baseUrl).href, byteRange: mapByteRange };
      } else if (!line.startsWith("#")) {
        segments.push({
          url: new URL(line, baseUrl).href,
          duration,
          byteRange: currentByteRange,
        });
        currentByteRange = null;
        duration = 0;
      }
    }
    return { segments, key, initMap, isLive };
  }

  return { isMaster, parseMaster, parseMedia };
})();

if (typeof module !== "undefined") module.exports = HLS;
