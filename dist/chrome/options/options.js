/* global chrome, browser */
if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;

const DEFAULTS = { concurrency: 4, nameTpl: "{title}", nativeHost: "" };

async function load() {
  const cfg = await browser.storage.sync.get(DEFAULTS);
  document.getElementById("concurrency").value = cfg.concurrency;
  document.getElementById("nameTpl").value = cfg.nameTpl;
  document.getElementById("nativeHost").value = cfg.nativeHost;
}

document.getElementById("save").addEventListener("click", async () => {
  await browser.storage.sync.set({
    concurrency: Math.max(1, Math.min(16, +document.getElementById("concurrency").value || 4)),
    nameTpl: document.getElementById("nameTpl").value || "{title}",
    nativeHost: document.getElementById("nativeHost").value.trim(),
  });
  const el = document.getElementById("saved");
  el.textContent = "已保存";
  setTimeout(() => (el.textContent = ""), 2000);
});

load();
