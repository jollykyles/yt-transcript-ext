// YouTube Transcript Grabber v1.2
// Priority: user-created (manual) subtitles first — English preferred —
// then English auto-generated (ASR) as fallback.
//
// Caption acquisition, in order:
//  1. DOM scrape of the open YouTube tab (auto-opens the transcript panel).
//     Most reliable — reads exactly what the "Show transcript" panel shows,
//     and immune to YouTube's API format churn.
//  2. InnerTube get_transcript (handles both legacy renderer and the new
//     "modern transcript view" view-model response formats).
//  3. Legacy timedtext (often blocked by proof-of-origin tokens now).

const urlInput = document.getElementById("urlInput");
const fetchBtn = document.getElementById("fetchBtn");
const statusEl = document.getElementById("status");
const resultArea = document.getElementById("resultArea");
const transcriptEl = document.getElementById("transcript");
const sourceBadge = document.getElementById("sourceBadge");
const tsToggle = document.getElementById("tsToggle");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

let cues = [];
let currentVideoId = "";
let activeTab = null;

// ---------- helpers ----------

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.classList.remove("hidden");
}

function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(url)) return url;
  let u;
  try {
    u = new URL(url.includes("://") ? url : "https://" + url);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") {
    const id = u.pathname.split("/")[1];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
  }
  if (host.endsWith("youtube.com")) {
    const v = u.searchParams.get("v");
    if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
    const m = u.pathname.match(/^\/(shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[2];
  }
  return null;
}

function extractPlayerResponse(html) {
  const marker = "ytInitialPlayerResponse";
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const braceStart = html.indexOf("{", idx);
    if (braceStart === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = braceStart; i < html.length; i++) {
      const c = html[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}") {
          depth--;
          if (depth === 0) {
            try {
              return JSON.parse(html.slice(braceStart, i + 1));
            } catch {
              break;
            }
          }
        }
      }
    }
    idx = html.indexOf(marker, idx + marker.length);
  }
  return null;
}

function trackName(t) {
  return (
    t.name?.simpleText ||
    (t.name?.runs || []).map(r => r.text).join("") ||
    t.languageCode ||
    "unknown"
  );
}

// Selection: manual English > any manual > English ASR
function pickTrack(tracks) {
  const isEn = t => (t.languageCode || "").toLowerCase().startsWith("en");
  const manual = tracks.filter(t => t.kind !== "asr");
  const auto = tracks.filter(t => t.kind === "asr");
  let track = manual.find(isEn);
  if (track) return { track, source: "manual" };
  if (manual.length) return { track: manual[0], source: "manual" };
  track = auto.find(isEn);
  if (track) return { track, source: "auto" };
  return null;
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// "1:05" or "1:05:12" -> seconds
function parseTimestamp(ts) {
  const parts = (ts || "").trim().split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function decodeEntities(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s;
  return el.value;
}

// ---------- method 1: scrape the open YouTube tab ----------

// Injected into the YouTube tab. Reads segments from the transcript panel,
// opening the panel first if needed. Handles both the modern view-model
// components and the legacy renderer components.
async function pageScrapeFn() {
  const parse = () => {
    const out = [];
    document.querySelectorAll("transcript-segment-view-model").forEach(el => {
      const ts =
        el.querySelector(".ytwTranscriptSegmentViewModelTimestamp")?.textContent?.trim() || "";
      const text =
        el.querySelector(".ytAttributedStringHost")?.textContent?.trim() || "";
      if (text) out.push({ ts, text });
    });
    if (out.length) return out;
    document.querySelectorAll("ytd-transcript-segment-renderer").forEach(el => {
      const ts = el.querySelector(".segment-timestamp")?.textContent?.trim() || "";
      const text = el.querySelector(".segment-text, yt-formatted-string.segment-text")?.textContent?.trim() || "";
      if (text) out.push({ ts, text });
    });
    return out;
  };

  let segs = parse();
  if (segs.length) return segs;

  // Panel not open (or not loaded) — find and click "Show transcript"
  const candidates = [...document.querySelectorAll("button, ytd-button-renderer button")];
  const showBtn = candidates.find(b => {
    const label = (b.getAttribute("aria-label") || "").toLowerCase();
    const text = (b.textContent || "").trim().toLowerCase();
    return label.includes("show transcript") || text === "show transcript";
  });
  if (showBtn) showBtn.click();

  // Poll up to ~10 seconds for segments to render
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    segs = parse();
    if (segs.length) return segs;
  }
  return [];
}

async function fetchViaTabScrape(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: pageScrapeFn,
  });
  const raw = results?.[0]?.result || [];
  const out = raw
    .map(r => ({ start: parseTimestamp(r.ts), text: r.text.replace(/\s+/g, " ").trim() }))
    .filter(r => r.text);
  if (!out.length) throw new Error("no transcript segments found in the page");
  return out;
}

// ---------- minimal protobuf encoding (for get_transcript params) ----------

function encVarint(n) {
  const out = [];
  n = n >>> 0;
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

function encString(field, str) {
  const bytes = new TextEncoder().encode(str);
  return [(field << 3) | 2, ...encVarint(bytes.length), ...bytes];
}

function encVarintField(field, val) {
  return [(field << 3) | 0, ...encVarint(val)];
}

function bytesToB64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function buildTranscriptParams(videoId, languageCode, isAsr) {
  const inner = [
    ...encString(1, isAsr ? "asr" : ""),
    ...encString(2, languageCode || "en"),
    ...encString(3, ""),
  ];
  const outer = [
    ...encString(1, videoId),
    // YouTube URL-encodes the inner base64 before embedding it
    // (verified byte-for-byte against a real getTranscriptEndpoint blob).
    ...encString(2, encodeURIComponent(bytesToB64(inner))),
    ...encVarintField(3, 1),
    ...encString(5, "engagement-panel-searchable-transcript-search-panel"),
    ...encVarintField(6, 1),
    ...encVarintField(7, 1),
    ...encVarintField(8, 1),
  ];
  return bytesToB64(outer);
}

function buildDefaultTranscriptParams(videoId) {
  return bytesToB64(encString(1, videoId));
}

// ---------- method 2: InnerTube get_transcript ----------

// Walks the response for transcript segments in BOTH known formats:
//  - legacy: transcriptSegmentRenderer { startMs, snippet: { runs: [{text}] } }
//  - modern: transcriptSegmentViewModel-style objects using
//            snippet/text with a plain "content" string
function collectSegments(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectSegments(n, out);
    return;
  }
  const seg =
    node.transcriptSegmentRenderer ||
    node.transcriptSegmentViewModel ||
    (typeof node.startMs !== "undefined" && (node.snippet || node.text) ? node : null);
  if (seg && (seg.snippet || seg.text)) {
    const snip = seg.snippet || seg.text;
    let text = "";
    if (typeof snip === "string") text = snip;
    else if (typeof snip.content === "string") text = snip.content;
    else if (snip.runs) text = snip.runs.map(x => x.text || "").join("");
    else if (snip.simpleText) text = snip.simpleText;
    text = text.replace(/\n/g, " ").trim();
    if (text) {
      out.push({ start: Number(seg.startMs || 0) / 1000, text });
      return;
    }
  }
  for (const k in node) collectSegments(node[k], out);
}

async function fetchViaInnerTube(videoId, track, watchHtml) {
  const cvMatch =
    watchHtml.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION":"([^"]+)"/) ||
    watchHtml.match(/"clientVersion":"([\d.]+)"/);
  const clientVersion = cvMatch ? cvMatch[1] : "2.20260101.00.00";

  const attempts = [
    buildTranscriptParams(videoId, track.languageCode, track.kind === "asr"),
    buildDefaultTranscriptParams(videoId),
  ];

  for (const params of attempts) {
    try {
      const res = await fetch(
        "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false",
        {
          method: "POST",
          credentials: "omit",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            context: {
              client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" },
            },
            params,
          }),
        }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const out = [];
      collectSegments(data, out);
      if (out.length) return out;
    } catch {
      /* try next */
    }
  }
  throw new Error("get_transcript returned no segments");
}

// ---------- method 3: legacy timedtext ----------

async function fetchViaTimedtext(baseUrl) {
  try {
    const res = await fetch(baseUrl + "&fmt=json3", { credentials: "omit" });
    if (res.ok) {
      const text = await res.text();
      if (text.trim()) {
        const data = JSON.parse(text);
        const out = [];
        for (const ev of data.events || []) {
          if (!ev.segs) continue;
          const line = ev.segs.map(s => s.utf8 || "").join("");
          const cleaned = line.replace(/\n/g, " ").trim();
          if (cleaned) out.push({ start: (ev.tStartMs || 0) / 1000, text: cleaned });
        }
        if (out.length) return out;
      }
    }
  } catch { /* fall through */ }

  const res = await fetch(baseUrl, { credentials: "omit" });
  if (!res.ok) throw new Error("timedtext HTTP " + res.status);
  const xml = await res.text();
  if (!xml.trim()) throw new Error("timedtext returned an empty response");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const out = [];
  for (const node of doc.querySelectorAll("text")) {
    const text = decodeEntities(node.textContent || "").replace(/\n/g, " ").trim();
    if (text) out.push({ start: parseFloat(node.getAttribute("start") || "0"), text });
  }
  if (!out.length) throw new Error("couldn't parse timedtext XML");
  return out;
}

// ---------- main flow ----------

async function run() {
  const videoId = extractVideoId(urlInput.value);
  if (!videoId) {
    setStatus("That doesn't look like a YouTube URL or video ID.", "error");
    return;
  }

  currentVideoId = videoId;
  fetchBtn.disabled = true;
  resultArea.classList.add("hidden");
  sourceBadge.classList.add("hidden");

  try {
    // Track info (for the badge + priority check) from the watch page
    setStatus("Fetching video info…");
    let picked = null;
    let html = "";
    try {
      const res = await fetch(
        `https://www.youtube.com/watch?v=${videoId}&hl=en&has_verified=1`,
        { credentials: "omit" }
      );
      if (res.ok) {
        html = await res.text();
        const pr = extractPlayerResponse(html);
        const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (pr && !tracks.length) {
          throw new Error("This video has no subtitles or captions at all.");
        }
        picked = pickTrack(tracks);
        if (tracks.length && !picked) {
          const langs = tracks
            .map(t => trackName(t) + (t.kind === "asr" ? " (auto)" : ""))
            .join(", ");
          throw new Error(
            "No user-created subtitles and no English auto-captions. Available: " + langs
          );
        }
      }
    } catch (e) {
      if (/no subtitles|No user-created/.test(e.message)) throw e;
      /* watch-page fetch is best-effort; scraping can still work */
    }

    // Method 1: scrape the open tab if it's showing this exact video
    const tabVideoId = extractVideoId(activeTab?.url || "");
    if (activeTab?.id && tabVideoId === videoId) {
      setStatus("Reading transcript from the open tab…");
      try {
        cues = await fetchViaTabScrape(activeTab.id);
      } catch { cues = []; }
    } else {
      cues = [];
    }

    // Method 2 + 3: network fallbacks
    if (!cues.length && picked) {
      setStatus("Downloading captions via API…");
      try {
        cues = await fetchViaInnerTube(videoId, picked.track, html);
      } catch {
        setStatus("Trying fallback caption source…");
        try {
          cues = await fetchViaTimedtext(picked.track.baseUrl);
        } catch { cues = []; }
      }
    }

    if (!cues.length) {
      throw new Error(
        tabVideoId === videoId
          ? "Couldn't read the transcript from the page or the API. Try clicking YouTube's own 'Show transcript' button once, then hit Fetch again."
          : "API methods failed for this video. Open the video in this tab, then click the extension and hit Fetch — it will read the transcript directly from the page."
      );
    }

    if (picked) {
      sourceBadge.textContent =
        (picked.source === "manual" ? "Manual · " : "Auto-generated · ") +
        trackName(picked.track);
      sourceBadge.className = "badge " + picked.source;
    } else {
      sourceBadge.textContent = "From page transcript";
      sourceBadge.className = "badge manual";
    }

    render();
    resultArea.classList.remove("hidden");
    setStatus(cues.length + " caption lines loaded.", "ok");
  } catch (err) {
    setStatus(err.message || String(err), "error");
  } finally {
    fetchBtn.disabled = false;
  }
}

function buildText(withTimestamps) {
  return cues
    .map(c => (withTimestamps ? `[${fmtTime(c.start)}] ${c.text}` : c.text))
    .join("\n");
}

function render() {
  transcriptEl.textContent = buildText(tsToggle.checked);
}

// ---------- UI wiring ----------

fetchBtn.addEventListener("click", run);
urlInput.addEventListener("keydown", e => { if (e.key === "Enter") run(); });
tsToggle.addEventListener("change", render);

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(buildText(tsToggle.checked));
  copyBtn.textContent = "Copied";
  setTimeout(() => (copyBtn.textContent = "Copy"), 1400);
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([buildText(tsToggle.checked)], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `transcript-${currentVideoId || "youtube"}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
});

chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  activeTab = tabs?.[0] || null;
  const tabUrl = activeTab?.url || "";
  if (extractVideoId(tabUrl)) {
    urlInput.value = tabUrl;
    setStatus("Detected the video in your current tab — hit Fetch or Enter.");
  }
  urlInput.focus();
});
