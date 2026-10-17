// popup.js — media list for the active tab (Video DownloadHelper style).
/* global chrome, browser */
if (typeof globalThis.browser === "undefined") globalThis.browser = chrome;

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const countEl = document.getElementById("count");
const tpl = document.getElementById("item-tpl");

function fmtSize(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)}${u[i]}`;
}

function formatDuration(sec) {
  if (!sec || isNaN(sec) || sec <= 0) return "";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) {
    return `${String(m).padStart(2, "0")}:${String(remS).padStart(2, "0")}`;
  }
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${String(h).padStart(2, "0")}:${String(remM).padStart(2, "0")}:${String(remS).padStart(2, "0")}`;
}

const LABEL = { hls: "HLS", dash: "DASH", video: "MP4", audio: "音频" };

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const tab = await activeTab();
  let media = [];
  try {
    const res = await browser.runtime.sendMessage({ type: "vh-get-media", tabId: tab?.id });
    if (Array.isArray(res)) media = res;
  } catch (err) {
    console.warn("Failed to fetch media list:", err);
  }

  emptyEl.style.display = media.length ? "none" : "";
  countEl.textContent = media.length ? `${media.length} 个视频` : "";

  // 1. 移除非当前列表的陈旧 DOM 节点，避免全量销毁重建
  const currentIds = new Set(media.map((m) => m.id));
  listEl.querySelectorAll(".item").forEach((el) => {
    if (!currentIds.has(el.dataset.entryId)) {
      el.remove();
    }
  });

  // 2. 原位复用或新增卡片节点
  for (const entry of media) {
    let root = listEl.querySelector(`.item[data-entry-id="${entry.id}"]`);
    let isNew = false;
    if (!root) {
      const node = tpl.content.cloneNode(true);
      root = node.querySelector(".item");
      root.dataset.entryId = entry.id;
      isNew = true;
    }

    const thumb = root.querySelector(".thumb");
    const durEl = root.querySelector(".duration");
    const badge = root.querySelector(".badge");
    const name = root.querySelector(".name");
    const sub = root.querySelector(".sub");
    const select = root.querySelector(".variant-select");
    const btn = root.querySelector(".dl");
    const bar = root.querySelector(".progress");

    // 缩略图平滑更新（若未变动不重复赋值触发浏览器闪图）
    const targetThumb = entry.thumbnail || "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 60'><rect width='96' height='60' fill='%231f1f23'/><polygon points='40,22 60,30 40,38' fill='%23ea580c'/></svg>";
    if (thumb.getAttribute("src") !== targetThumb) {
      thumb.src = targetThumb;
    }

    // 时长更新
    if (entry.duration > 0) {
      const durStr = formatDuration(entry.duration);
      if (durEl.textContent !== durStr) durEl.textContent = durStr;
      durEl.style.display = "block";
    } else {
      durEl.style.display = "none";
    }

    // 徽标更新
    const badgeText = LABEL[entry.type] || entry.type.toUpperCase();
    if (badge.textContent !== badgeText) badge.textContent = badgeText;
    badge.className = `badge ${entry.type}`;

    // 标题更新
    const titleText = entry.pageTitle || entry.url.split("/").pop().split("?")[0] || entry.url;
    if (name.textContent !== titleText) name.textContent = titleText;
    name.title = entry.url;

    // 动态码率与预估大小更新
    let hostStr = "";
    try { hostStr = new URL(entry.url).hostname; } catch {}

    function getVariantSize(variantUrl) {
      if (entry.type !== "hls" && entry.type !== "dash") {
        return entry.size > 0 ? fmtSize(entry.size) : "";
      }
      const v = entry.variants?.find((x) => x.url === variantUrl) || entry.variants?.[0];
      const bw = v?.bandwidth || 0;
      if (bw > 0 && entry.duration > 0) {
        return `~${fmtSize(Math.round((bw * entry.duration) / 8))}`;
      }
      if (entry.estimatedSize > 0) {
        return `~${fmtSize(entry.estimatedSize)}`;
      }
      return "";
    }

    function refreshSubtitle(chosenUrl) {
      const parts = [hostStr];
      const sz = getVariantSize(chosenUrl);
      if (sz) parts.push(sz);
      if (entry.duration > 0) parts.push(formatDuration(entry.duration));
      sub.textContent = parts.filter(Boolean).join(" · ");
    }

    // 清晰度下拉选项增量构建
    if (entry.variants && entry.variants.length > 0) {
      const currentVal = select.value;
      const optsSignature = entry.variants.map((v) => `${v.url}|${v.bandwidth}|${entry.duration}`).join(";");
      if (select.dataset.sig !== optsSignature) {
        select.innerHTML = "";
        for (const v of entry.variants) {
          const opt = document.createElement("option");
          opt.value = v.url;
          let optSizeStr = "";
          if (v.bandwidth > 0 && entry.duration > 0) {
            optSizeStr = ` (~${fmtSize(Math.round((v.bandwidth * entry.duration) / 8))})`;
          }
          opt.textContent = `MP4 ${v.name || "HD"}${optSizeStr}`;
          select.appendChild(opt);
        }
        select.dataset.sig = optsSignature;
        if (currentVal && select.querySelector(`option[value="${CSS.escape(currentVal)}"]`)) {
          select.value = currentVal;
        }
      }
      select.style.display = "block";
      select.onchange = () => refreshSubtitle(select.value);
    } else {
      select.style.display = "none";
    }

    refreshSubtitle(select.value || entry.url);

    // 新增卡片时绑定下载事件
    if (isNew) {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "处理中";
        bar.classList.add("on");
        try {
          const chosenVariantUrl = (entry.variants?.length && select.value) ? select.value : entry.url;
          const res = await browser.runtime.sendMessage({
            type: "vh-download",
            entry,
            variantUrl: chosenVariantUrl,
          });
          if (res && res.ok === false) {
            throw new Error(res.error || "下载失败");
          }
          btn.textContent = "已开始";
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "重试";
          sub.textContent = String(err?.message || err);
        }
      };

      listEl.appendChild(root);
    }
  }
}

// live engine progress & live media list updates
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "vh-media-updated") {
    render();
    return;
  }
  if (msg?.type !== "vh-engine-progress" || !msg.relayed) return;
  if (msg.phase === "segments" && msg.total) {
    document.querySelectorAll(".item .dl:disabled").forEach((btn) => {
      const bar = btn.closest(".item").querySelector(".bar");
      bar.style.width = `${Math.round((msg.done / msg.total) * 100)}%`;
    });
  }
  if (msg.phase === "transmuxing") {
    document.querySelectorAll(".item .dl:disabled").forEach((btn) => {
      btn.textContent = "封装中...";
    });
  }
});

document.getElementById("refresh").addEventListener("click", render);

document.getElementById("clear")?.addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab?.id) {
    await browser.runtime.sendMessage({ type: "vh-clear-media", tabId: tab.id });
    render();
  }
});

// --- 自定义视频地址/网页地址输入解析 ---
const customUrlInput = document.getElementById("custom-url");
const parseUrlBtn = document.getElementById("parse-url");

async function parseCustomUrl() {
  const url = customUrlInput?.value?.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    alert("请输入以 http:// 或 https:// 开头的有效网址");
    return;
  }
  parseUrlBtn.disabled = true;
  parseUrlBtn.textContent = "解析中...";
  try {
    const tab = await activeTab();
    const res = await browser.runtime.sendMessage({
      type: "vh-parse-url",
      url,
      tabId: tab?.id,
    });
    if (!res || res.ok === false) {
      throw new Error(res?.error || "未在此地址中提取到可下载的视频");
    }
    customUrlInput.value = "";
    await render();
  } catch (err) {
    alert(err?.message || "解析失败");
  } finally {
    parseUrlBtn.disabled = false;
    parseUrlBtn.textContent = "解析";
  }
}

parseUrlBtn?.addEventListener("click", parseCustomUrl);
customUrlInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    parseCustomUrl();
  }
});

render();
