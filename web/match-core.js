const NOISE =
  /(?:^|[_\-\s.])(?:upscaled|upscale|upsc|upres|vsr|flashvsr|flash[\s_-]?vsr|realesrgan|topaz|enhanced|enhance|scaled|sr|4k|2160p|1440p|1080p|720p|480p|x2|x4|x8|2x|4x|final|out|output|export|render|graded|copy|dup|duplicate)(?=$|[_\-\s.\d])/gi;
const COPY_MARK = /(?:\s*\(\d+\)|\s*\[\d+\]|[_\-\s]copy(?:[_\-\s]?\d+)?)$/i;

function stemOf(filename) {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  return base
    .replace(/up-\d{3,}/gi, " ")
    .replace(/\b\d{3,5}x\d{3,5}\b/gi, " ")
    .replace(NOISE, " ")
    .replace(COPY_MARK, " ")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stemsMatch(a, b) {
  const sa = stemOf(a);
  const sb = stemOf(b);
  return sa.length >= 3 && sa === sb;
}

function hasUpscaleToken(filename) {
  return /upscaled|upscale|upsc|upres|\bvsr\b|flashvsr|realesrgan|topaz|enhanced|\b4k\b|2160p|1080p|\bx[248]\b|\b[24]x\b/i.test(filename);
}

function hasCopyNoise(filename) {
  return COPY_MARK.test(filename.replace(/\.[^.]+$/, "")) || /\bcopy\b/i.test(filename);
}

function mosaicSim(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i++) {
    meanA += a[i] || 0;
    meanB += b[i] || 0;
  }
  meanA /= n;
  meanB /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  let mse = 0;
  for (let i = 0; i < n; i++) {
    const xa = (a[i] || 0) - meanA;
    const xb = (b[i] || 0) - meanB;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
    const d = (a[i] || 0) - (b[i] || 0);
    mse += d * d;
  }
  const corr = da && db ? num / Math.sqrt(da * db) : 0;
  const corrScore = (Math.max(-1, Math.min(1, corr)) + 1) / 2;
  const mseScore = 1 - Math.min(1, mse / n / (48 * 48));
  return corrScore * 0.7 + mseScore * 0.3;
}

function visualScore(a, b) {
  const n = Math.min((a.mosaics || []).length, (b.mosaics || []).length);
  if (!n) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) acc += mosaicSim(a.mosaics[i] || [], b.mosaics[i] || []);
  return acc / n;
}

function durationClose(a, b) {
  if (!a || !b) return true;
  const diff = Math.abs(a - b);
  return diff < 0.45 || diff / Math.max(a, b) < 0.12;
}

function pairIdentity(a, b) {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function cluster(items) {
  const byHash = new Map();
  for (const item of items) {
    const key = `${item.size}:${item.byteHash}`;
    const arr = byHash.get(key) || [];
    arr.push(item);
    byHash.set(key, arr);
  }
  const copies = [];
  const canonical = [];
  for (const group of byHash.values()) {
    const keeper = [...group].sort((a, b) => {
      const noise = Number(hasCopyNoise(a.name)) - Number(hasCopyNoise(b.name));
      if (noise) return noise;
      if (b.size !== a.size) return b.size - a.size;
      return a.name.localeCompare(b.name);
    })[0];
    canonical.push(keeper);
    if (group.length > 1) {
      copies.push({
        id: `copy:${keeper.byteHash}:${keeper.size}`,
        memberIds: group.map((item) => item.id),
        keeperId: keeper.id,
        wastedBytes: group.reduce((sum, item) => (item.id === keeper.id ? sum : sum + item.size), 0),
      });
    }
  }
  const edges = [];
  for (let i = 0; i < canonical.length; i++) {
    for (let j = i + 1; j < canonical.length; j++) {
      const a = canonical[i];
      const b = canonical[j];
      if (a.kind !== b.kind || !durationClose(a.duration, b.duration)) continue;
      const nameMatch = stemsMatch(a.name, b.name);
      const visual = visualScore(a, b);
      if (!(visual >= 0.84 || (nameMatch && visual >= 0.5))) continue;
      edges.push({ i, j, visual, nameMatch });
    }
  }
  edges.sort((a, b) => b.visual - a.visual || Number(b.nameMatch) - Number(a.nameMatch));
  const used = new Set();
  const pairs = [];
  for (const edge of edges) {
    if (used.has(edge.i) || used.has(edge.j)) continue;
    used.add(edge.i);
    used.add(edge.j);
    const a = canonical[edge.i];
    const b = canonical[edge.j];
    const areaA = (a.width || 0) * (a.height || 0);
    const areaB = (b.width || 0) * (b.height || 0);
    let before = a;
    let after = b;
    if (areaA !== areaB && areaA && areaB) {
      before = areaA < areaB ? a : b;
      after = before === a ? b : a;
    } else if (hasUpscaleToken(a.name) !== hasUpscaleToken(b.name)) {
      before = hasUpscaleToken(a.name) ? b : a;
      after = before === a ? b : a;
    } else if (a.size !== b.size) {
      before = a.size < b.size ? a : b;
      after = before === a ? b : a;
    }
    const reason =
      !edge.nameMatch && edge.visual >= 0.84
        ? "Names don't match. The frames are still the same shot."
        : edge.nameMatch && edge.visual >= 0.84
          ? "Names line up, and the frames are the same shot."
          : edge.nameMatch
            ? "Names line up. Check the frames before you lock it."
            : "Frames are close. Check before you lock it.";
    pairs.push({
      id: pairIdentity(before.id, after.id),
      beforeId: before.id,
      afterId: after.id,
      visual: edge.visual,
      nameMatch: edge.nameMatch,
      reason,
    });
  }
  const paired = new Set(pairs.flatMap((pair) => [pair.beforeId, pair.afterId]));
  return {
    copies,
    pairs,
    aloneIds: canonical.filter((item) => !paired.has(item.id)).map((item) => item.id),
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
