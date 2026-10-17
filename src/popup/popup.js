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

function applyJobProgress(itemEl, state) {
  if (!itemEl || !state) return;
  const btn = itemEl.querySelector(".dl");
  const barWrap = itemEl.querySelector(".progress");
  const barInner = itemEl.querySelector(".bar");
  if (!btn || !barWrap || !barInner) return;

  itemEl._downloading = true;
  btn.disabled = true;
  barWrap.classList.add("on");

  if (state.phase === "starting" || state.phase === "playlist") {
    btn.textContent = "准备中...";
    barInner.style.width = "8%";
  } else if (state.phase === "segments") {
    const p = state.percent !== undefined ? state.percent : (state.total > 0 ? Math.round((state.done / state.total) * 100) : 0);
    btn.textContent = `${p}%`;
    barInner.style.width = `${p}%`;
  } else if (state.phase === "transmuxing") {
    btn.textContent = "封装中...";
    barInner.style.width = "100%";
  } else if (state.phase === "done") {
    btn.textContent = "已开始";
    barInner.style.width = "100%";
    setTimeout(() => {
      itemEl._downloading = false;
      btn.disabled = false;
      btn.textContent = "↓ 下载";
      barWrap.classList.remove("on");
      barInner.style.width = "0%";
    }, 2500);
  } else if (state.phase === "error") {
    itemEl._downloading = false;
    btn.disabled = false;
    btn.textContent = "重试";
    barWrap.classList.remove("on");
  }
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ==========================================
// 缩略图悬停视频动态微预览控制器
// 支持 MP4 直链与 HLS (m3u8) 快速切片微播，离开即销毁
// @author ZHANGCHAO 2026/10/17
// ==========================================
let currentActiveStop = null;

function setupHoverPreview(root) {
  const thumbWrap = root.querySelector(".thumb-wrap");
  const video = thumbWrap?.querySelector(".preview-video");
  if (!thumbWrap || !video) return;

  let hoverTimer = null;
  let hlsInstance = null;
  let playPromise = null;
  let isHovering = false;

  function stopPreview() {
    isHovering = false;
    if (hoverTimer) {
      clearTimeout(hoverTimer);
      hoverTimer = null;
    }
    video.classList.remove("active");
    video.onplaying = null;
    video.onerror = null;

    if (hlsInstance) {
      try {
        hlsInstance.destroy();
      } catch {}
      hlsInstance = null;
    }

    if (playPromise !== null) {
      playPromise
        .then(() => {
          video.pause();
          video.removeAttribute("src");
          video.load();
        })
        .catch(() => {
          video.pause();
          video.removeAttribute("src");
          video.load();
        })
        .finally(() => {
          playPromise = null;
        });
    } else {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }

    if (currentActiveStop === stopPreview) {
      currentActiveStop = null;
    }
  }

  function startPreview() {
    if (!isHovering) return;
    if (currentActiveStop && currentActiveStop !== stopPreview) {
      currentActiveStop();
    }
    currentActiveStop = stopPreview;

    const entry = root._entry;
    if (!entry) return;

    // 清晰度优化：微预览优先选用 360p~720p 适中码率的 variant，确保毫秒级起播且节省带宽
    let playUrl = entry.url;
    if (entry.variants && entry.variants.length > 0) {
      const sorted = [...entry.variants].sort((a, b) => (a.bandwidth || 0) - (b.bandwidth || 0));
      const fastVariant = sorted.find((v) => (v.height || 0) >= 360) || sorted[0];
      if (fastVariant?.url) playUrl = fastVariant.url;
    }

    if (!playUrl) return;

    video.onplaying = () => {
      if (isHovering) {
        video.classList.add("active");
      } else {
        stopPreview();
      }
    };
    video.onerror = () => {
      stopPreview();
    };

    const isHls = entry.type === "hls" || playUrl.includes(".m3u8");

    if (isHls && window.Hls && window.Hls.isSupported()) {
      try {
        hlsInstance = new window.Hls({
          maxBufferLength: 4,      // 预览仅缓冲 4 秒切片
          maxMaxBufferLength: 8,
          enableWorker: false,     // 扩展 popup 中关闭 Worker，避免触发 CSP 拦截
          lowLatencyMode: true,
        });
        hlsInstance.loadSource(playUrl);
        hlsInstance.attachMedia(video);
        hlsInstance.on(window.Hls.Events.MANIFEST_PARSED, () => {
          if (!isHovering) {
            stopPreview();
            return;
          }
          playPromise = video.play();
        });
        hlsInstance.on(window.Hls.Events.ERROR, (event, data) => {
          if (data && data.fatal) stopPreview();
        });
      } catch (err) {
        console.warn("HLS hover preview init failed:", err);
        stopPreview();
      }
    } else {
      // 原生直链 MP4 / WebM 或原生支持 HLS (如 Safari)
      video.src = playUrl;
      video.currentTime = 0;
      playPromise = video.play();
    }
  }

  thumbWrap.addEventListener("mouseenter", () => {
    isHovering = true;
    hoverTimer = setTimeout(startPreview, 160); // 160ms 防抖，过滤鼠标非刻意掠过
  });

  thumbWrap.addEventListener("mouseleave", () => {
    stopPreview();
  });
}

async function render() {
  const tab = await activeTab();
  let media = [];
  let downloadStates = {};
  try {
    const res = await browser.runtime.sendMessage({ type: "vh-get-media", tabId: tab?.id });
    if (Array.isArray(res)) {
      media = res;
    } else if (res && typeof res === "object") {
      media = Array.isArray(res.media) ? res.media : [];
      downloadStates = res.downloadStates || {};
    }
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

    // 始终将最新的 entry 数据挂载到 DOM 元素上，杜绝闭包数据滞后
    root._entry = entry;

    const thumb = root.querySelector(".thumb");
    const durEl = root.querySelector(".duration");
    const badge = root.querySelector(".badge");
    const name = root.querySelector(".name");
    const sub = root.querySelector(".sub");
    const select = root.querySelector(".variant-select");
    const locateBtn = root.querySelector(".locate-btn");
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

    // 标题更新：优先使用带有推文作者和正文的标题，若仍为“主页 / X”则提取媒体识别特征避免混淆
    let titleText = entry.pageTitle;
    if (!titleText || titleText.trim() === "主页 / X" || titleText.trim() === "X") {
      const twMatch = (entry.url || "").match(/(?:amplify_video|ext_tw_video)\/(\d+)/i);
      if (twMatch) {
        titleText = `X 视频 (${twMatch[1].slice(-6)})`;
      } else {
        titleText = entry.url.split("/").pop().split("?")[0] || entry.url;
      }
    }
    if (name.textContent !== titleText) name.textContent = titleText;
    name.title = entry.pageUrl ? `${titleText}\n推文地址: ${entry.pageUrl}\n按住 Ctrl 点击可在新标签打开` : `${titleText}\n${entry.url}`;

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
      if (bw > 0) {
        return `~${Math.round(bw / 1000)}kbps`;
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
          } else if (v.bandwidth > 0) {
            optSizeStr = ` (~${Math.round(v.bandwidth / 1000)}kbps)`;
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

    // 检查并恢复后台活跃任务下载状态
    const activeState = downloadStates[entry.id];
    if (activeState) {
      applyJobProgress(root, activeState);
    } else if (!root._downloading) {
      btn.disabled = false;
      btn.textContent = "↓ 下载";
      bar.classList.remove("on");
      bar.querySelector(".bar").style.width = "0%";
    }

    // 新增卡片时绑定事件
    if (isNew) {
      setupHoverPreview(root);

      const doLocate = async () => {
        const curEntry = root._entry || entry;
        try {
          const curTab = await activeTab();
          if (curTab?.id) {
            await browser.runtime.sendMessage({
              type: "vh-locate-media",
              tabId: curTab.id,
              entry: curEntry,
            });
          }
        } catch {}
      };

      const thumbWrap = root.querySelector(".thumb-wrap");
      if (locateBtn) locateBtn.onclick = doLocate;
      if (thumbWrap) thumbWrap.onclick = doLocate;
      else thumb.onclick = doLocate;
      name.onclick = (e) => {
        const curEntry = root._entry || entry;
        if ((e.ctrlKey || e.metaKey) && curEntry.pageUrl) {
          browser.tabs.create({ url: curEntry.pageUrl });
          return;
        }
        doLocate();
      };

      btn.onclick = async () => {
        const curEntry = root._entry || entry;
        applyJobProgress(root, { phase: "starting", percent: 5 });
        try {
          const chosenVariantUrl = (curEntry.variants?.length && select.value) ? select.value : curEntry.url;
          const res = await browser.runtime.sendMessage({
            type: "vh-download",
            entry: curEntry,
            variantUrl: chosenVariantUrl,
          });
          if (res && res.ok === false) {
            throw new Error(res.error || "下载失败");
          }
        } catch (err) {
          applyJobProgress(root, { phase: "error" });
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

  const entryId = msg.entryId || (msg.id ? String(msg.id).replace(/^job-/, "") : null);
  if (!entryId) return;

  const root = listEl.querySelector(`.item[data-entry-id="${entryId}"]`);
  if (!root) return;

  const total = msg.total || 0;
  const done = msg.done || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : (msg.phase === "transmuxing" || msg.phase === "done" ? 100 : 0);

  applyJobProgress(root, {
    phase: msg.phase,
    done,
    total,
    percent,
    error: msg.error,
  });
});

document.getElementById("refresh").addEventListener("click", () => {
  if (currentActiveStop) currentActiveStop();
  render();
});

document.getElementById("clear")?.addEventListener("click", async () => {
  if (currentActiveStop) currentActiveStop();
  const tab = await activeTab();
  if (tab?.id) {
    await browser.runtime.sendMessage({ type: "vh-clear-media", tabId: tab.id });
    render();
  }
});

window.addEventListener("unload", () => {
  if (currentActiveStop) currentActiveStop();
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
