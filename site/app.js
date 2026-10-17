/**
 * VideoHarvest 官方网站互动模拟器逻辑
 * 支持卡片悬停微预览、清晰度联动、实时下载进度模拟、自定义链接解析
 * @author ZHANGCHAO 2026/10/17
 */

document.addEventListener("DOMContentLoaded", () => {
  // 1. 缩略图 Canvas 动态粒子/流光播放微预览模拟
  function setupCanvasAnimation(canvasId, hueStart) {
    const container = document.getElementById(canvasId);
    if (!container) return;

    const canvas = document.createElement("canvas");
    canvas.width = 96;
    canvas.height = 60;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    let animId = null;
    let t = 0;
    let isPlaying = false;

    // 默认绘制静态微缩封面
    function drawStatic() {
      ctx.fillStyle = `hsl(${hueStart}, 40%, 15%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 静态装饰线
      ctx.strokeStyle = `hsla(${hueStart}, 80%, 60%, 0.4)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(10, 30);
      ctx.bezierCurveTo(30, 15, 60, 45, 86, 30);
      ctx.stroke();

      // 播放小三角
      ctx.fillStyle = "#ea580c";
      ctx.beginPath();
      ctx.moveTo(42, 24);
      ctx.lineTo(56, 30);
      ctx.lineTo(42, 36);
      ctx.closePath();
      ctx.fill();
    }

    // 动态微预览渲染循环
    function renderLoop() {
      t += 0.08;
      ctx.fillStyle = `hsl(${hueStart}, 60%, 10%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // 绘制动态多层音频/视频光波
      for (let layer = 0; layer < 3; layer++) {
        ctx.beginPath();
        ctx.strokeStyle = `hsla(${hueStart + layer * 25}, 85%, 60%, ${0.7 - layer * 0.2})`;
        ctx.lineWidth = 2.5;

        for (let x = 0; x <= canvas.width; x += 4) {
          const y = 30 + Math.sin(x * 0.08 + t + layer) * (8 + layer * 3) + Math.cos(t * 1.5) * 4;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // 粒子光点
      for (let i = 0; i < 4; i++) {
        const px = (t * 20 + i * 25) % canvas.width;
        const py = 20 + Math.sin(t + i) * 15;
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(px, py, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (isPlaying) {
        animId = requestAnimationFrame(renderLoop);
      }
    }

    drawStatic();

    const wrap = container.closest(".sim-thumb-wrap");
    if (wrap) {
      wrap.addEventListener("mouseenter", () => {
        isPlaying = true;
        renderLoop();
      });
      wrap.addEventListener("mouseleave", () => {
        isPlaying = false;
        if (animId) cancelAnimationFrame(animId);
        drawStatic();
      });
    }
  }

  setupCanvasAnimation("sim-thumb-canvas-1", 240); // 科技紫蓝光波
  setupCanvasAnimation("sim-thumb-canvas-2", 160); // 极客绿光波

  // 2. 清晰度切换联动
  const select1 = document.getElementById("sim-select-1");
  const sub1 = document.getElementById("sim-sub-1");
  if (select1 && sub1) {
    select1.addEventListener("change", () => {
      const opt = select1.options[select1.selectedIndex];
      const sizeStr = opt.dataset.size || "99.8MB";
      sub1.textContent = `video.twimg.com · ~${sizeStr} · 01:51`;
    });
  }

  // 3. 真实模拟分片下载流程
  function bindDownload(btnId, progressId) {
    const btn = document.getElementById(btnId);
    const progress = document.getElementById(progressId);
    if (!btn || !progress) return;

    const bar = progress.querySelector(".sim-progress-bar");

    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      progress.classList.add("on");

      let percent = 0;
      const interval = setInterval(() => {
        percent += Math.floor(Math.random() * 12) + 6;
        if (percent >= 100) {
          percent = 100;
          clearInterval(interval);
          bar.style.width = "100%";
          btn.textContent = "转封装中...";

          setTimeout(() => {
            progress.classList.remove("on");
            bar.style.width = "0%";
            btn.textContent = "✓ 已完成 (MP4)";
            btn.style.background = "#15803d";

            setTimeout(() => {
              btn.disabled = false;
              btn.textContent = "↓ 下载";
              btn.style.background = "";
            }, 3000);
          }, 800);
        } else {
          bar.style.width = `${percent}%`;
          btn.textContent = `${percent}%`;
        }
      }, 150);
    });
  }

  bindDownload("sim-dl-1", "sim-progress-1");
  bindDownload("sim-dl-2", "sim-progress-2");

  // 4. 刷新与清空按钮交互
  const refreshBtn = document.getElementById("sim-refresh-btn");
  const clearBtn = document.getElementById("sim-clear-btn");
  const simList = document.getElementById("sim-list");
  const simCount = document.getElementById("sim-count");

  if (clearBtn && simList && simCount) {
    clearBtn.addEventListener("click", () => {
      simList.innerHTML = `<div style="padding: 30px 10px; text-align: center; color: #71717a; font-size: 12px;">当前页面未检测到视频<br><small>播放视频后再打开本面板，或点击左下角刷新</small></div>`;
      simCount.textContent = "";
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refreshBtn.style.transform = "rotate(360deg)";
      refreshBtn.style.transition = "transform 0.6s ease";
      setTimeout(() => {
        refreshBtn.style.transform = "";
        refreshBtn.style.transition = "";
        location.reload();
      }, 700);
    });
  }

  // 5. 自定义解析输入模拟
  const parseBtn = document.getElementById("sim-parse-btn");
  const urlInput = document.getElementById("sim-url-input");
  if (parseBtn && urlInput) {
    parseBtn.addEventListener("click", () => {
      const origText = parseBtn.textContent;
      parseBtn.textContent = "解析中...";
      parseBtn.disabled = true;

      setTimeout(() => {
        parseBtn.textContent = "✓ 解析成功";
        parseBtn.style.background = "#15803d";
        setTimeout(() => {
          parseBtn.textContent = origText;
          parseBtn.style.background = "";
          parseBtn.disabled = false;
        }, 2000);
      }, 800);
    });
  }
});
