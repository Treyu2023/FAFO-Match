const API = location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:18766";
const app = document.querySelector("#app");
const state = {
  tab: "pairs",
  items: [],
  files: new Map(),
  result: { pairs: [], copies: [], aloneIds: [] },
  selected: null,
  mode: "wipe",
  wipe: 56,
  server: false,
  note: "",
  working: "",
  decisions: {},
  keepers: {},
  flips: {},
  toast: "",
};

function idOf(item) {
  return `${item.path}\n${item.size}\n${item.mtime || 0}`;
}

function byId(id) {
  return state.items.find((item) => item.id === id);
}

function toast(text) {
  state.toast = text;
  render();
  setTimeout(() => {
    if (state.toast === text) {
      state.toast = "";
      render();
    }
  }, 2200);
}

async function probe() {
  try {
    const res = await fetch(`${API}/api/health`, { cache: "no-store" });
    state.server = res.ok;
  } catch {
    state.server = false;
  }
}

function shownPair(pair) {
  if (!state.flips[pair.id]) return pair;
  return { ...pair, beforeId: pair.afterId, afterId: pair.beforeId };
}

function report() {
  const lines = ["FAFO Match", ""];
  lines.push("PAIRS");
  if (!state.result.pairs.length) lines.push("None.");
  for (const raw of state.result.pairs) {
    const pair = shownPair(raw);
    const status = state.decisions[pair.id] || "review";
    lines.push(`- ${status.toUpperCase()}  ${pair.reason}`);
    lines.push(`  before  ${byId(pair.beforeId)?.path || ""}`);
    lines.push(`  after   ${byId(pair.afterId)?.path || ""}`);
  }
  lines.push("", "COPIES");
  if (!state.result.copies.length) lines.push("None.");
  for (const group of state.result.copies) {
    const keep = state.keepers[group.id] || group.keeperId;
    lines.push(`- keep  ${byId(keep)?.path || ""}`);
    for (const id of group.memberIds) {
      if (id !== keep) lines.push(`  copy  ${byId(id)?.path || ""}`);
    }
  }
  lines.push("", "ALONE");
  for (const id of state.result.aloneIds) lines.push(`- ${byId(id)?.path || ""}`);
  if (!state.result.aloneIds.length) lines.push("None.");
  lines.push("", "Matched on this PC. Nothing was uploaded.");
  return lines.join("\n");
}

async function readFrame(source, sw, sh) {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 9;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, 16, 9);
  const data = ctx.getImageData(0, 0, 16, 9).data;
  const mosaic = [];
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4;
      mosaic.push(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    }
  }
  const thumb = document.createElement("canvas");
  thumb.width = 160;
  thumb.height = Math.max(1, Math.round((sh / Math.max(1, sw)) * 160));
  thumb.getContext("2d").drawImage(source, 0, 0, sw, sh, 0, 0, thumb.width, thumb.height);
  return { mosaic, thumb: thumb.toDataURL("image/jpeg", 0.7) };
}

function seek(video, time) {
  return new Promise((resolve, reject) => {
    const target = Math.min(Math.max(0, time), Math.max(0, (video.duration || 0) - 0.04));
    const ok = () => {
      video.removeEventListener("seeked", ok);
      resolve();
    };
    video.addEventListener("seeked", ok);
    video.addEventListener("error", () => reject(new Error("seek")), { once: true });
    if (Math.abs(video.currentTime - target) < 0.03 && video.readyState >= 2) {
      video.removeEventListener("seeked", ok);
      resolve();
      return;
    }
    video.currentTime = target;
  });
}

async function fingerprintFile(file, path) {
  const url = URL.createObjectURL(file);
  const kind = /\.(mp4|m4v|mov|webm|mkv|avi|ogv)$/i.test(file.name) ? "video" : "image";
  try {
    if (kind === "image") {
      const img = new Image();
      img.src = url;
      await img.decode();
      const frame = await readFrame(img, img.naturalWidth, img.naturalHeight);
      const buf = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const byteHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return {
        id: `${path}\n${file.size}\n${file.lastModified}`,
        name: file.name,
        path,
        size: file.size,
        mtime: file.lastModified,
        kind,
        width: img.naturalWidth,
        height: img.naturalHeight,
        duration: 0,
        byteHash,
        mosaics: [frame.mosaic],
        dhashes: [],
        thumb: frame.thumb,
        file,
      };
    }
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 12000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => reject(new Error("unreadable"));
    });
    const mosaics = [];
    let thumb = "";
    for (const t of [0.2, 0.5, 0.8]) {
      await seek(video, (video.duration || 0) * t);
      const frame = await readFrame(video, video.videoWidth, video.videoHeight);
      mosaics.push(frame.mosaic);
      if (!thumb) thumb = frame.thumb;
    }
    const sample = await file.slice(0, Math.min(file.size, 2 * 1024 * 1024)).arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", sample);
    const byteHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return {
      id: `${path}\n${file.size}\n${file.lastModified}`,
      name: file.name,
      path,
      size: file.size,
      mtime: file.lastModified,
      kind: "video",
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration || 0,
      byteHash: `${file.size}:${byteHash}`,
      mosaics,
      dhashes: [],
      thumb,
      file,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ingestFiles(fileList) {
  const files = [...fileList].filter((file) => /\.(mp4|m4v|mov|webm|mkv|avi|ogv|jpg|jpeg|png|webp|gif|bmp)$/i.test(file.name));
  if (!files.length) {
    state.note = "Nothing in there was a video or image.";
    render();
    return;
  }
  state.working = `Reading ${files.length} files`;
  render();
  const items = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    state.working = file.name;
    render();
    try {
      const path = file.webkitRelativePath || file.name;
      items.push(await fingerprintFile(file, path));
    } catch {
      /* skip unreadable */
    }
  }
  state.items = items;
  state.result = cluster(items);
  lockCertain();
  state.tab = state.result.pairs.length ? "pairs" : state.result.copies.length ? "copies" : "alone";
  state.working = "";
  state.note = "";
  state.selected = null;
  render();
}

async function scanFolder() {
  const input = document.querySelector("#folder");
  const path = input?.value.trim();
  if (!path) return;
  state.working = "Asking the local server to scan";
  render();
  await fetch(`${API}/api/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  for (;;) {
    const res = await fetch(`${API}/api/scan`);
    const job = await res.json();
    state.working = job.phase === "done" ? "" : `Scanning ${job.done || 0} of ${job.total || 0}`;
    if (job.phase === "done" || job.phase === "error") {
      const items = (job.items || []).map((item) => ({ ...item, id: idOf(item), thumb: "" }));
      state.items = items;
      state.result = cluster(items);
      lockCertain();
      state.tab = state.result.pairs.length ? "pairs" : state.result.copies.length ? "copies" : "alone";
      state.working = "";
      state.note = job.error || (job.ffmpeg ? "" : "ffmpeg was not found, so renamed upscales need a dropped file to compare frames.");
      state.selected = null;
      render();
      return;
    }
    render();
    await new Promise((r) => setTimeout(r, 400));
  }
}

function mediaUrl(item) {
  if (item.file) return URL.createObjectURL(item.file);
  if (state.server && item.path) return `${API}/media?path=${encodeURIComponent(item.path)}`;
  return "";
}

function render() {
  const pairs = state.result.pairs.map(shownPair);
  const open = pairs.filter((pair) => !state.decisions[pair.id]).length;
  const wasted = state.result.copies.reduce((sum, group) => sum + (group.wastedBytes || 0), 0);
  app.innerHTML = `
    <header>
      <div>
        <p class="eyebrow">FAFO</p>
        <h1>Match</h1>
      </div>
      <div class="row">
        ${state.items.length ? `<button class="solid" id="export">Export list</button>` : ""}
      </div>
    </header>
    ${state.working ? `<section class="lead"><h2>${escapeHtml(state.working)}</h2><div class="bar"><i style="width:40%"></i></div></section>` : ""}
    ${!state.items.length && !state.working ? emptyHtml() : ""}
    ${state.items.length && !state.working ? bodyHtml(pairs, open, wasted) : ""}
    ${state.toast ? `<p class="toast">${escapeHtml(state.toast)}</p>` : ""}
  `;
  bind();
}

function emptyHtml() {
  return `
    <section>
      <p class="lead">Drop a folder of videos. Identical files land in Copies. The same shot at two sizes lands in Pairs, even when an upscaler renamed it. You review both here.</p>
      <div class="row">
        <button class="solid" id="pick">Open a folder</button>
        <button class="quiet" id="sample">Load a sample</button>
      </div>
      <p class="hint">${state.server ? "Folder scan is on. Paste a path from this PC." : "Dropped files work now. Start FAFO Match to scan a folder and send copies to the recycle bin."}</p>
      ${state.server ? `<div class="row"><input id="folder" type="text" placeholder="C:\\Videos\\upscales" /><button class="quiet" id="scan">Scan folder</button></div>` : ""}
      <p class="hint">Files stay on this PC. Nothing is uploaded.</p>
      ${state.note ? `<p class="warn">${escapeHtml(state.note)}</p>` : ""}
      <input id="files" type="file" multiple webkitdirectory hidden />
    </section>`;
}

function bodyHtml(pairs, open, wasted) {
  const counts = {
    pairs: `Pairs ${pairs.length}`,
    copies: `Copies ${state.result.copies.length}`,
    alone: `Alone ${state.result.aloneIds.length}`,
  };
  return `
    <section class="grid">
      <div>
        <div class="tabs" role="tablist">
          ${["pairs", "copies", "alone"].map((tab) => `<button role="tab" data-tab="${tab}" aria-selected="${state.tab === tab}">${counts[tab]}</button>`).join("")}
        </div>
        <p class="hint">${state.tab === "pairs" ? (open ? `${open} still to check` : "All pairs checked") : state.tab === "copies" ? (wasted ? `${formatBytes(wasted)} if you keep every copy` : "No copies") : "No partner found"}</p>
        ${state.note ? `<p class="warn">${escapeHtml(state.note)}</p>` : ""}
        <div class="list">${listHtml(pairs)}</div>
      </div>
      <div>${stageHtml(pairs)}</div>
    </section>`;
}

function listHtml(pairs) {
  if (state.tab === "pairs") {
    return pairs
      .map((pair) => {
        const left = byId(pair.beforeId);
        const right = byId(pair.afterId);
        return `<button class="item" data-id="${escapeAttr(pair.id)}" aria-pressed="${state.selected === pair.id}">
          ${thumb(left)}${thumb(right)}
          <span class="meta"><strong>${escapeHtml(left?.name || "")} → ${escapeHtml(right?.name || "")}</strong><span>${escapeHtml(pair.reason)}</span></span>
          <span class="score">${Math.round(pair.visual * 100)}</span>
        </button>`;
      })
      .join("");
  }
  if (state.tab === "copies") {
    return state.result.copies
      .map((group) => {
        const keep = byId(state.keepers[group.id] || group.keeperId);
        return `<button class="item" data-id="${escapeAttr(group.id)}" aria-pressed="${state.selected === group.id}">
          ${thumb(keep)}<span class="meta"><strong>${escapeHtml(keep?.name || "")}</strong><span>${group.memberIds.length} files, same bytes. Keep one.</span></span>
        </button>`;
      })
      .join("");
  }
  return state.result.aloneIds
    .map((id) => {
      const item = byId(id);
      return `<button class="item" data-id="${escapeAttr(id)}" aria-pressed="${state.selected === id}">${thumb(item)}<span class="meta"><strong>${escapeHtml(item?.name || "")}</strong><span>No copy and no matching shot.</span></span></button>`;
    })
    .join("");
}

function thumb(item) {
  return item?.thumb ? `<img alt="" src="${item.thumb}" />` : `<span class="ph"></span>`;
}

function stageHtml(pairs) {
  const pair = pairs.find((item) => item.id === state.selected);
  const group = state.result.copies.find((item) => item.id === state.selected);
  const alone = state.result.aloneIds.includes(state.selected) ? byId(state.selected) : null;
  let before = null;
  let after = null;
  let beforeLabel = "Before";
  let afterLabel = "After";
  if (pair) {
    before = byId(pair.beforeId);
    after = byId(pair.afterId);
  } else if (group) {
    const keep = state.keepers[group.id] || group.keeperId;
    before = byId(keep);
    after = byId(group.memberIds.find((id) => id !== keep));
    beforeLabel = "Keep";
    afterLabel = "Copy";
  } else if (alone) {
    before = alone;
    beforeLabel = "Clip";
  }
  if (!before) return `<p class="hint">Pick a row.</p>`;
  const beforeUrl = mediaUrl(before);
  const afterUrl = after ? mediaUrl(after) : "";
  const tag = before.kind === "image" ? "img" : "video";
  const afterTag = after && after.kind === "image" ? "img" : "video";
  return `
    <div class="stage" data-before="${escapeAttr(beforeUrl)}" data-after="${escapeAttr(afterUrl)}" data-bk="${before.kind}" data-ak="${after?.kind || ""}">
      ${after ? `<div class="modes">${["wipe", "split", "diff"].map((mode) => `<button data-mode="${mode}" aria-selected="${state.mode === mode}">${mode === "wipe" ? "Wipe" : mode === "split" ? "Side by side" : "Difference"}</button>`).join("")}</div>` : ""}
      <div class="viewer" id="viewer"></div>
      <div class="row" style="margin-top:.6rem">
        ${before.kind === "video" || after?.kind === "video" ? `<button class="solid" id="play">Play</button>` : ""}
        ${pair ? `<button class="solid" id="lock">${state.decisions[pair.id] === "locked" ? "Unlock" : "Lock pair"}</button><button class="quiet" id="swap">Swap</button><button class="quiet" id="reject">${state.decisions[pair.id] === "rejected" ? "Put back" : "Not a pair"}</button>` : ""}
        ${group && state.server ? `<button class="quiet" id="recycle">Recycle the copies</button>` : ""}
        <button class="texty" id="paths">Copy paths</button>
      </div>
      ${group ? `<fieldset>${group.memberIds.map((id) => `<label class="keep"><input type="radio" name="keep" value="${escapeAttr(id)}" ${((state.keepers[group.id] || group.keeperId) === id) ? "checked" : ""}/> ${escapeHtml(byId(id)?.name || "")}</label>`).join("")}</fieldset>` : ""}
      <p class="hint">${escapeHtml(pair?.reason || (group ? "Same bytes. Safe to keep one." : "Nothing else in this drop looks like this file."))}</p>
    </div>`;
}

function mountViewer() {
  const stage = document.querySelector(".stage");
  const viewer = document.querySelector("#viewer");
  if (!stage || !viewer) return;
  const beforeUrl = stage.dataset.before;
  const afterUrl = stage.dataset.after;
  const make = (url, kind, label, cls) => {
    if (!url) return null;
    const el = document.createElement(kind === "image" ? "img" : "video");
    if (el.tagName === "VIDEO") {
      el.muted = true;
      el.playsInline = true;
      el.preload = "auto";
    }
    el.src = url;
    const cap = document.createElement("span");
    cap.className = `cap ${cls}`;
    cap.textContent = label;
    const wrap = document.createElement("div");
    wrap.className = "clip";
    wrap.append(el, cap);
    return { wrap, el };
  };
  const before = make(beforeUrl, stage.dataset.bk, document.querySelector("#lock") ? "Before" : "Keep", "before");
  const after = afterUrl ? make(afterUrl, stage.dataset.ak, document.querySelector("#lock") ? "After" : "Copy", "after") : null;
  if (!before) return;
  if (!after || state.mode === "wipe") {
    if (after) viewer.append(after.wrap);
    before.wrap.style.clipPath = after && state.mode === "wipe" ? `inset(0 ${100 - state.wipe}% 0 0)` : "";
    viewer.append(before.wrap);
    if (after && state.mode === "wipe") {
      const line = document.createElement("div");
      line.className = "handle";
      line.style.left = `${state.wipe}%`;
      const range = document.createElement("input");
      range.type = "range";
      range.min = "0";
      range.max = "100";
      range.value = String(state.wipe);
      range.className = "wipe";
      range.setAttribute("aria-label", "Wipe between before and after");
      range.addEventListener("input", () => {
        state.wipe = Number(range.value);
        before.wrap.style.clipPath = `inset(0 ${100 - state.wipe}% 0 0)`;
        line.style.left = `${state.wipe}%`;
      });
      viewer.append(line, range);
    }
  } else if (state.mode === "split") {
    viewer.style.display = "grid";
    viewer.style.gridTemplateColumns = "1fr 1fr";
    viewer.append(before.wrap, after.wrap);
  }
  const play = document.querySelector("#play");
  play?.addEventListener("click", async () => {
    const videos = [...viewer.querySelectorAll("video")];
    if (videos.some((video) => !video.paused)) videos.forEach((video) => video.pause());
    else await Promise.all(videos.map((video) => video.play()));
  });
}

function bind() {
  document.querySelector("#pick")?.addEventListener("click", () => document.querySelector("#files")?.click());
  document.querySelector("#files")?.addEventListener("change", (event) => ingestFiles(event.target.files));
  document.querySelector("#sample")?.addEventListener("click", loadSample);
  document.querySelector("#scan")?.addEventListener("click", scanFolder);
  document.querySelector("#export")?.addEventListener("click", async () => {
    const text = report();
    const blob = new Blob([text], { type: "text/plain" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "fafo-match.txt";
    link.click();
    try { await navigator.clipboard.writeText(text); toast("List copied and downloaded."); }
    catch { toast("List downloaded."); }
  });
  document.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => {
    state.tab = button.dataset.tab;
    state.selected = null;
    render();
  }));
  document.querySelectorAll(".item").forEach((button) => button.addEventListener("click", () => {
    state.selected = button.dataset.id;
    render();
  }));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    state.mode = button.dataset.mode;
    render();
  }));
  document.querySelector("#lock")?.addEventListener("click", () => {
    const cur = state.decisions[state.selected];
    const locking = cur !== "locked";
    state.decisions[state.selected] = locking ? "locked" : "open";
    if (locking) stampSelected();
    render();
  });
  document.querySelector("#swap")?.addEventListener("click", () => {
    state.flips[state.selected] = !state.flips[state.selected];
    render();
  });
  document.querySelector("#reject")?.addEventListener("click", () => {
    const cur = state.decisions[state.selected];
    state.decisions[state.selected] = cur === "rejected" ? "open" : "rejected";
    render();
  });
  document.querySelector("#paths")?.addEventListener("click", async () => {
    const text = report();
    try { await navigator.clipboard.writeText(text); toast("Paths copied."); }
    catch { toast("Couldn't copy."); }
  });
  document.querySelector("#recycle")?.addEventListener("click", recycleCopies);
  document.querySelectorAll("input[name=keep]").forEach((input) => input.addEventListener("change", () => {
    const group = state.result.copies.find((item) => item.id === state.selected);
    if (!group) return;
    state.keepers[group.id] = input.value;
    render();
  }));
  mountViewer();
}

async function recycleCopies() {
  const group = state.result.copies.find((item) => item.id === state.selected);
  if (!group) return;
  const keep = state.keepers[group.id] || group.keeperId;
  const paths = group.memberIds.filter((id) => id !== keep).map((id) => byId(id)?.path).filter(Boolean);
  const res = await fetch(`${API}/api/recycle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  const body = await res.json();
  toast(body.recycled?.length ? `Recycled ${body.recycled.length}.` : "Couldn't recycle those files.");
}

function lockCertain() {
  for (const pair of state.result.pairs) {
    if (pair.certain && !state.decisions[pair.id]) state.decisions[pair.id] = "locked";
  }
}

function stampSelected() {
  const pair = state.result.pairs.map(shownPair).find((item) => item.id === state.selected);
  if (!pair || pair.certain) return;
  const left = byId(pair.beforeId);
  const right = byId(pair.afterId);
  if (!left || !right) return;
  const taken = new Set(state.items.map((item) => pidOf(item.name) || pidOf(item.path)).filter(Boolean));
  const pid = pidOf(left.name) || pidOf(left.path) || pidOf(right.name) || pidOf(right.path) || mintPid(taken);
  const oldLeft = left.path;
  const oldRight = right.path;
  left.name = stampPid(left.name, pid);
  left.path = stampPid(left.path, pid);
  right.name = stampPid(right.name, pid);
  right.path = stampPid(right.path, pid);
  state.result = cluster(state.items);
  lockCertain();
  if (state.server) {
    fetch(`${API}/api/stamp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pid, paths: [oldLeft, oldRight] }),
    }).catch(() => {});
  }
  toast(`Process id ${pid} is on both names.`);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => {
    if (ch === "&") return "&" + "amp;";
    if (ch === "<") return "&" + "lt;";
    if (ch === ">") return "&" + "gt;";
    if (ch === '"') return "&" + "quot;";
    return "&" + "#39;";
  });
}
function escapeAttr(value) { return escapeHtml(value); }

async function loadSample() {
  state.working = "Building a sample set";
  render();
  const paint = (ctx, w, h, scene, sharp) => {
    ctx.fillStyle = scene === "alley" ? "#141820" : scene === "dragon" ? "#1a120c" : "#101614";
    ctx.fillRect(0, 0, w, h);
    if (scene === "alley") {
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? "#3aa8a8" : "#c46a3c";
        ctx.fillRect(w * (0.1 + i * 0.17), h * 0.08, Math.max(2, w * 0.02), h * 0.7);
      }
      ctx.fillStyle = sharp ? "#f4f4f4" : "#bdbdbd";
      ctx.fillRect(w * 0.4, h * 0.5, w * 0.12, h * 0.28);
    } else if (scene === "dragon") {
      ctx.strokeStyle = sharp ? "#ff8a3d" : "#d06028";
      ctx.lineWidth = h * 0.12;
      ctx.beginPath();
      ctx.moveTo(w * 0.12, h * 0.72);
      ctx.quadraticCurveTo(w * 0.42, h * 0.16, w * 0.86, h * 0.42);
      ctx.stroke();
    } else {
      ctx.fillStyle = "#d7e26a";
      ctx.beginPath();
      ctx.arc(w * 0.32, h * 0.42, h * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  const blobOf = (scene, sharp, w, h) => new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    paint(canvas.getContext("2d"), w, h, scene, sharp);
    canvas.toBlob(resolve, "image/png");
  });
  const specs = [
    ["alley", false, 320, 180, "alley_take.png"],
    ["alley", false, 320, 180, "alley_take (1).png"],
    ["alley", true, 640, 360, "alley_take_upscaled.png"],
    ["dragon", false, 320, 180, "dragon_pass.png"],
    ["dragon", true, 640, 360, "sr_dump_00481.png"],
    ["sign", false, 320, 180, "lone_sign.png"],
  ];
  const files = [];
  let shared = null;
  for (const [scene, sharp, w, h, name] of specs) {
    let blob = name.includes("(1)") ? shared : await blobOf(scene, sharp, w, h);
    if (name === "alley_take.png") shared = blob;
    files.push(new File([blob], name, { type: "image/png", lastModified: Date.now() }));
  }
  await ingestFiles(files);
}

document.body.addEventListener("dragover", (event) => event.preventDefault());
document.body.addEventListener("drop", (event) => {
  event.preventDefault();
  if (event.dataTransfer?.files?.length) ingestFiles(event.dataTransfer.files);
});

probe().then(render);
setInterval(() => {
  if (!state.server) return;
  fetch(`${API}/api/heartbeat`, { method: "POST" }).catch(() => {});
}, 20000);
