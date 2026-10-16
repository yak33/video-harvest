// url-util.js — tiny shared helpers (no dependencies).
/* global module */

const UrlUtil = {
  resolve(base, ref) {
    try { return new URL(ref, base).href; } catch { return ref; }
  },
  hostOf(url) {
    try { return new URL(url).hostname; } catch { return ""; }
  },
};

if (typeof module !== "undefined") module.exports = UrlUtil;
