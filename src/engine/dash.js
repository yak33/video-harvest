// dash.js — minimal DASH MPD parser (SegmentTemplate + SegmentList, static profiles).
/* global module */

const DASH = (() => {
  function parseMpd(xmlText, baseUrl) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid MPD");

    const base = doc.querySelector("MPD > BaseURL")?.textContent?.trim();
    const mpdBase = base ? new URL(base, baseUrl).href : baseUrl;

    const reps = [];
    doc.querySelectorAll('AdaptationSet[contentType="video"], AdaptationSet[mimeType^="video"], AdaptationSet:not([contentType])').forEach((as) => {
      const asTemplate = as.querySelector(":scope > SegmentTemplate");
      const asList = as.querySelector(":scope > SegmentList");
      as.querySelectorAll("Representation").forEach((r) => {
        const rep = {
          id: r.getAttribute("id") || "1",
          bandwidth: parseInt(r.getAttribute("bandwidth"), 10) || 0,
          width: parseInt(r.getAttribute("width"), 10) || 0,
          height: parseInt(r.getAttribute("height"), 10) || 0,
          mimeType: r.getAttribute("mimeType") || as.getAttribute("mimeType") || "video/mp4",
          name: r.getAttribute("height") ? `${r.getAttribute("height")}p` : `${Math.round((parseInt(r.getAttribute("bandwidth"), 10) || 0) / 1000)}kbps`,
        };
        const tpl = r.querySelector(":scope > SegmentTemplate") || asTemplate;
        const list = r.querySelector(":scope > SegmentList") || asList;
        if (tpl) {
          rep.template = {
            media: tpl.getAttribute("media") || "",
            initialization: tpl.getAttribute("initialization") || "",
            startNumber: parseInt(tpl.getAttribute("startNumber"), 10) || 1,
            timescale: parseInt(tpl.getAttribute("timescale"), 10) || 1,
            duration: parseInt(tpl.getAttribute("duration"), 10) || 0,
            timeline: [...tpl.querySelectorAll("S")].map((s) => ({
              t: parseInt(s.getAttribute("t"), 10) || 0,
              d: parseInt(s.getAttribute("d"), 10) || 0,
              r: parseInt(s.getAttribute("r"), 10) || 0,
            })),
          };
        } else if (list) {
          rep.segments = [...list.querySelectorAll("SegmentURL")].map((s) => s.getAttribute("media"));
          const init = list.querySelector("Initialization");
          rep.initialization = init?.getAttribute("sourceURL") || "";
        } else {
          const baseUrlEl = r.querySelector(":scope > BaseURL");
          if (baseUrlEl) rep.singleUrl = baseUrlEl.textContent.trim();
        }
        if (rep.template || rep.segments || rep.singleUrl) rep.base = mpdBase;
        if (rep.template || rep.segments || rep.singleUrl) reps.push(rep);
      });
    });

    // Also extract audio adaptation sets so audio tracks are not lost
    const audioReps = [];
    doc.querySelectorAll('AdaptationSet[contentType="audio"], AdaptationSet[mimeType^="audio"]').forEach((as) => {
      const asTemplate = as.querySelector(":scope > SegmentTemplate");
      const asList = as.querySelector(":scope > SegmentList");
      as.querySelectorAll("Representation").forEach((r) => {
        const rep = {
          id: r.getAttribute("id") || "audio-1",
          bandwidth: parseInt(r.getAttribute("bandwidth"), 10) || 0,
          mimeType: r.getAttribute("mimeType") || as.getAttribute("mimeType") || "audio/mp4",
          name: `${Math.round((parseInt(r.getAttribute("bandwidth"), 10) || 0) / 1000)}kbps`,
        };
        const tpl = r.querySelector(":scope > SegmentTemplate") || asTemplate;
        const list = r.querySelector(":scope > SegmentList") || asList;
        if (tpl) {
          rep.template = {
            media: tpl.getAttribute("media") || "",
            initialization: tpl.getAttribute("initialization") || "",
            startNumber: parseInt(tpl.getAttribute("startNumber"), 10) || 1,
            timescale: parseInt(tpl.getAttribute("timescale"), 10) || 1,
            duration: parseInt(tpl.getAttribute("duration"), 10) || 0,
            timeline: [...tpl.querySelectorAll("S")].map((s) => ({
              t: parseInt(s.getAttribute("t"), 10) || 0,
              d: parseInt(s.getAttribute("d"), 10) || 0,
              r: parseInt(s.getAttribute("r"), 10) || 0,
            })),
          };
        } else if (list) {
          rep.segments = [...list.querySelectorAll("SegmentURL")].map((s) => s.getAttribute("media"));
          const init = list.querySelector("Initialization");
          rep.initialization = init?.getAttribute("sourceURL") || "";
        }
        if (rep.template || rep.segments) rep.base = mpdBase;
        if (rep.template || rep.segments) audioReps.push(rep);
      });
    });

    // MPD duration (PT#H#M#S)
    const durAttr = doc.querySelector("MPD")?.getAttribute("mediaPresentationDuration") || "";
    const dm = durAttr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/);
    const duration = dm ? (+(dm[1] || 0)) * 3600 + (+(dm[2] || 0)) * 60 + (+parseFloat(dm[3] || 0)) : 0;

    return {
      representations: reps.sort((a, b) => b.bandwidth - a.bandwidth),
      audioRepresentations: audioReps.sort((a, b) => b.bandwidth - a.bandwidth),
      duration,
    };
  }

  function expandTemplate(str, rep, number, time = 0) {
    return str
      .replace(/\$\$/g, " ")
      .replace(/\$RepresentationID\$/g, rep.id)
      .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, pad) => String(number).padStart(parseInt(pad || "1", 10), "0"))
      .replace(/\$Time(?:%0(\d+)d)?\$/g, (_, pad) => String(time || 0).padStart(parseInt(pad || "1", 10), "0"))
      .replace(/ /g, "$");
  }

  // -> { initUrl|null, urls: [segmentUrl...] }
  function buildSegmentList(rep, mpdDuration) {
    if (rep.singleUrl) return { initUrl: null, urls: [new URL(rep.singleUrl, rep.base).href] };
    if (rep.segments) {
      return {
        initUrl: rep.initialization ? new URL(rep.initialization, rep.base).href : null,
        urls: rep.segments.map((s) => new URL(s, rep.base).href),
      };
    }
    const t = rep.template;
    const urls = [];
    let number = t.startNumber;
    let time = 0;
    if (t.timeline.length) {
      for (const s of t.timeline) {
        if (s.t !== undefined && s.t > 0) {
          time = s.t;
        }
        const repeat = s.r >= 0 ? s.r : 0;
        for (let i = 0; i <= repeat; i++) {
          urls.push(new URL(expandTemplate(t.media, rep, number, time), rep.base).href);
          number++;
          time += s.d;
        }
      }
    } else if (t.duration && mpdDuration) {
      const segDur = t.duration / t.timescale;
      const count = Math.ceil(mpdDuration / segDur);
      for (let i = 0; i < count; i++) {
        urls.push(new URL(expandTemplate(t.media, rep, number, time), rep.base).href);
        number++;
        time += t.duration;
      }
    }
    return {
      initUrl: t.initialization ? new URL(expandTemplate(t.initialization, rep, t.startNumber, 0), rep.base).href : null,
      urls,
    };
  }

  return { parseMpd, buildSegmentList };
})();

if (typeof module !== "undefined") module.exports = DASH;
