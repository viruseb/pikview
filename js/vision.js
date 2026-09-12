/**
 * Analyse d'image : préparation, détection du quadrillage, découpage en blocs
 * d'indices. Tout se fait sur un canvas, sans dépendance externe.
 *
 * Une feuille photographiée n'est jamais plane : la page se bombe, l'appareil
 * n'est pas perpendiculaire. Les traits d'une même ligne dérivent donc de
 * plusieurs pixels d'un bord à l'autre — assez pour qu'une détection de
 * segments strictement horizontaux les manque. Le quadrillage est donc
 * cherché bande par bande, puis chaque trait est suivi de bande en bande sous
 * forme de polyligne. Le résultat est un maillage : l'intersection de la
 * i-ème polyligne horizontale et de la j-ème verticale donne le coin (i, j).
 */

/** Dessine une source (video/image/bitmap) dans un canvas réduit à `maxDim`. */
export function toWorkingCanvas(source, maxDim = 1400) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * Canal « valeur » (max des composantes RVB) plutôt que luminance : les
 * grilles sont souvent tracées sur du papier réglé dont le réglage imprimé
 * est coloré, donc clair sur au moins un canal, là où l'encre noire est
 * sombre sur les trois.
 */
export function toGray(canvas) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    gray[p] = r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  return { gray, w, h };
}

function integral(src, w, h) {
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + rowSum;
    }
  }
  return ii;
}

function boxSum(ii, w, x0, y0, x1, y1) {
  const W = w + 1;
  return ii[y1 * W + x1] - ii[y0 * W + x1] - ii[y1 * W + x0] + ii[y0 * W + x0];
}

/** Seuillage adaptatif (moyenne locale) ; 1 = encre. */
export function adaptiveThreshold(gray, w, h, radius, delta = 10) {
  const ii = integral(gray, w, h);
  const ink = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const mean = boxSum(ii, w, x0, y0, x1, y1) / area;
      ink[y * w + x] = gray[y * w + x] < mean - delta ? 1 : 0;
    }
  }
  return ink;
}

/**
 * Estime l'inclinaison globale du document (radians), entre -6° et +6°.
 *
 * Conservé pour mémoire, mais plus utilisé par la chaîne d'analyse : sur une
 * photo de page réelle le score est trop plat (moins de 3 % d'écart entre le
 * pic et le plateau) pour départager un angle, et un redressement approximatif
 * dégrade la détection au lieu de l'aider. Les traits sont désormais suivis à
 * leur pente locale, ce qui rend l'opération inutile.
 */
export function estimateSkew(ink, w, h) {
  const step = Math.max(1, Math.round(Math.max(w, h) / 500));
  const sw = Math.ceil(w / step);
  const sh = Math.ceil(h / step);
  const small = new Uint8Array(sw * sh);
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (ink[y * w + x]) small[((y / step) | 0) * sw + ((x / step) | 0)] = 1;
    }
  }
  let best = 0;
  let bestScore = -1;
  for (let deg = -6; deg <= 6; deg += 0.25) {
    const t = Math.tan((deg * Math.PI) / 180);
    // Le décalage doit compenser les indices négatifs, qui n'apparaissent que
    // pour une pente positive : sans lui, une partie de l'encre tombe hors de
    // l'accumulateur et le score favorise arbitrairement un côté.
    const spread = Math.ceil(Math.abs(t) * sw);
    const off = t > 0 ? spread : 0;
    const proj = new Float64Array(sh + spread + 2);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (small[y * sw + x]) proj[(y - t * x + off) | 0]++;
      }
    }
    let score = 0;
    for (const v of proj) score += v * v;
    if (score > bestScore) { bestScore = score; best = (deg * Math.PI) / 180; }
  }
  return best;
}

/** Fait pivoter un canvas de `angle` radians (fond blanc). */
export function rotateCanvas(canvas, angle) {
  if (Math.abs(angle) < 0.0015) return canvas;
  const { width: w, height: h } = canvas;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const nw = Math.round(w * cos + h * sin);
  const nh = Math.round(w * sin + h * cos);
  const out = document.createElement('canvas');
  out.width = nw;
  out.height = nh;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(angle);
  ctx.drawImage(canvas, -w / 2, -h / 2);
  return out;
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Cherche, dans chaque bande, les positions transversales des traits longs.
 *
 * Chaque bande est examinée sous plusieurs pentes : une photo prise de biais
 * incline les traits de plusieurs degrés, et un trait incliné ne forme aucune
 * suite horizontale continue. Le redressement global de la page ne peut pas y
 * suppléer — sur une page bombée aucun angle unique ne convient, et le score
 * d'inclinaison est trop plat pour être fiable. On mesure donc la pente
 * localement, là où le trait est quasi droit.
 *
 * @param {boolean} horizontal true pour les traits horizontaux (bandes verticales)
 * @returns {{centers:number[], peaks:number[][]}}
 */
function stripPeaks(ink, w, h, horizontal, strips) {
  const along = horizontal ? w : h;   // direction du trait
  const across = horizontal ? h : w;  // direction de la projection
  const stripW = along / strips;
  const minRun = Math.max(10, stripW * 0.7);
  const at = horizontal
    ? (pos, cr) => (cr >= 0 && cr < across ? ink[cr * w + pos] : 0)
    : (pos, cr) => (cr >= 0 && cr < across ? ink[pos * w + cr] : 0);

  const SHEARS = [-0.1, -0.075, -0.05, -0.025, 0, 0.025, 0.05, 0.075, 0.1];
  const centers = [];
  const peaks = [];

  for (let s = 0; s < strips; s++) {
    const a0 = Math.floor(s * stripW);
    const a1 = Math.min(along, Math.ceil((s + 1) * stripW));
    const mid = (a0 + a1) / 2;
    centers.push(mid);

    let best = null;
    for (const shear of SHEARS) {
      const proj = new Float64Array(across);
      for (let cr = 0; cr < across; cr++) {
        let b = a0;
        let total = 0;
        while (b < a1) {
          if (!at(b, Math.round(cr + shear * (b - mid)))) { b++; continue; }
          const start = b;
          let last = b;
          let gap = 0;
          while (b < a1) {
            if (at(b, Math.round(cr + shear * (b - mid)))) { last = b; gap = 0; }
            else if (++gap > 2) break;
            b++;
          }
          if (last - start + 1 >= minRun) total += last - start + 1;
          b = last + 2;
        }
        proj[cr] = total;
      }
      let score = 0;
      for (const v of proj) score += v * v;
      if (!best || score > best.score) best = { score, proj };
    }

    const threshold = minRun * 0.85;
    const found = [];
    let i = 0;
    while (i < across) {
      if (best.proj[i] < threshold) { i++; continue; }
      let j = i;
      let sum = 0;
      let wsum = 0;
      while (j < across && best.proj[j] >= threshold) { sum += best.proj[j]; wsum += best.proj[j] * j; j++; }
      found.push(wsum / sum);
      i = j;
    }
    peaks.push(found);
  }
  return { centers, peaks };
}

/** Suit chaque trait de bande en bande pour en faire une polyligne. */
function trackLines(peaks, strips, pitch) {
  const tol = Math.max(3, pitch * 0.5);
  const tracks = [];
  for (let s = 0; s < strips; s++) {
    const used = new Set();
    // Rattachement au plus proche, en partant des appariements les plus sûrs.
    const candidates = [];
    for (const p of peaks[s]) {
      for (const t of tracks) {
        if (s - t.lastStrip > 2) continue;
        const d = Math.abs(t.lastValue - p);
        if (d < tol) candidates.push({ d, p, t });
      }
    }
    candidates.sort((a, b) => a.d - b.d);
    const taken = new Set();
    for (const cand of candidates) {
      if (used.has(cand.p) || taken.has(cand.t)) continue;
      used.add(cand.p);
      taken.add(cand.t);
      cand.t.values[s] = cand.p;
      cand.t.lastStrip = s;
      cand.t.lastValue = cand.p;
      cand.t.count++;
    }
    for (const p of peaks[s]) {
      if (used.has(p)) continue;
      const values = new Float64Array(strips).fill(NaN);
      values[s] = p;
      tracks.push({ values, lastStrip: s, lastValue: p, count: 1 });
    }
  }
  return tracks.filter((t) => t.count >= Math.max(2, Math.round(strips * 0.22)));
}

/** Complète une polyligne (interpolation interne, extrapolation aux bords). */
function fillTrack(values, strips, centers) {
  const known = [];
  for (let s = 0; s < strips; s++) if (!Number.isNaN(values[s])) known.push(s);
  if (!known.length) return null;
  if (known.length === 1) return values.fill(values[known[0]]);
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k];
    const b = known[k + 1];
    for (let s = a + 1; s < b; s++) {
      const t = (centers[s] - centers[a]) / (centers[b] - centers[a]);
      values[s] = values[a] + (values[b] - values[a]) * t;
    }
  }
  const extrapolate = (from, to, s0, s1) => {
    const slope = (values[to] - values[from]) / (centers[to] - centers[from]);
    for (let s = s0; s !== s1; s += Math.sign(s1 - s0)) {
      values[s] = values[from] + slope * (centers[s] - centers[from]);
    }
  };
  const first = known[0];
  const last = known[known.length - 1];
  if (first > 0) extrapolate(first, known[1], first - 1, -1);
  if (last < strips - 1) extrapolate(last, known[known.length - 2], last + 1, strips);
  return values;
}

function meanOf(values) {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/**
 * Détecte le maillage complet du tableau.
 * @returns {null|{hLines:Float64Array[], vLines:Float64Array[], sampleX:number[],
 *                 sampleY:number[], rows:number, cols:number,
 *                 pitchX:number, pitchY:number, nodes:Float64Array}}
 */
export function detectMesh(ink, w, h, strips = 12) {
  const hRaw = stripPeaks(ink, w, h, true, strips);
  const vRaw = stripPeaks(ink, w, h, false, strips);

  const gaps = (list) => {
    const out = [];
    for (const arr of list) for (let i = 1; i < arr.length; i++) out.push(arr[i] - arr[i - 1]);
    return out;
  };
  const rawPitchY = median(gaps(hRaw.peaks).filter((d) => d > 4));
  const rawPitchX = median(gaps(vRaw.peaks).filter((d) => d > 4));
  if (!rawPitchY || !rawPitchX) return null;

  const build = (raw, pitch, centers) => {
    let tracks = trackLines(raw.peaks, strips, pitch);
    tracks = tracks
      .map((t) => ({ values: fillTrack(t.values, strips, centers) }))
      .filter((t) => t.values)
      .sort((a, b) => meanOf(a.values) - meanOf(b.values));
    // Fusionne les doublons (trait épais détecté deux fois).
    const merged = [];
    for (const t of tracks) {
      const prev = merged[merged.length - 1];
      if (prev && Math.abs(meanOf(t.values) - meanOf(prev.values)) < pitch * 0.45) {
        for (let s = 0; s < strips; s++) prev.values[s] = (prev.values[s] + t.values[s]) / 2;
      } else {
        merged.push(t);
      }
    }
    // Pas réel, mesuré entre traits voisins.
    const positions = merged.map((t) => meanOf(t.values));
    const realGaps = [];
    for (let i = 1; i < positions.length; i++) realGaps.push(positions[i] - positions[i - 1]);
    const small = realGaps.filter((d) => d <= median(realGaps) * 1.6);
    let step = median(small.length ? small : realGaps) || pitch;

    // Ne garder que la plus longue suite régulièrement espacée.
    //
    // Le bord de la page, une ombre, un doigt au premier plan produisent des
    // traits bien nets hors du tableau. Sans ce filtre, l'étape suivante les
    // relie au quadrillage en comblant l'écart, et le maillage déborde sur
    // toute la photo. Un écart n'est accepté que s'il vaut une à trois fois le
    // pas : de quoi tolérer un trait pâle manqué, pas de quoi franchir une
    // marge blanche.
    //
    // Le pas est comparé à une estimation glissante, pas à une valeur unique :
    // vue de biais, une page voit son pas dériver d'un bout à l'autre, et un
    // seuil global finirait par couper la suite en plein milieu du tableau.
    const runs = [[0]];
    let localStep = step;
    for (let i = 1; i < positions.length; i++) {
      const gap = positions[i] - positions[i - 1];
      const k = Math.round(gap / localStep);
      if (k >= 1 && k <= 3 && Math.abs(gap / k - localStep) < localStep * 0.18) {
        runs[runs.length - 1].push(i);
        localStep = localStep * 0.7 + (gap / k) * 0.3;
      } else {
        runs.push([i]);
        localStep = step;
      }
    }
    const best = runs.reduce((a, b) => (b.length > a.length ? b : a));
    const kept = best.length >= 4 ? best.map((i) => merged[i]) : merged;
    if (kept.length >= 4) {
      const keptGaps = [];
      for (let i = 1; i < kept.length; i++) {
        keptGaps.push(meanOf(kept[i].values) - meanOf(kept[i - 1].values));
      }
      const keptSmall = keptGaps.filter((d) => d <= median(keptGaps) * 1.6);
      step = median(keptSmall.length ? keptSmall : keptGaps) || step;
    }

    // Insère les traits manqués à l'intérieur de la suite retenue.
    const full = [];
    for (let i = 0; i < kept.length; i++) {
      if (i > 0) {
        const gap = meanOf(kept[i].values) - meanOf(kept[i - 1].values);
        const k = Math.max(1, Math.round(gap / step));
        if (k > 1 && Math.abs(gap / k - step) < step * 0.35) {
          for (let t = 1; t < k; t++) {
            const values = new Float64Array(strips);
            for (let s = 0; s < strips; s++) {
              values[s] = kept[i - 1].values[s] + ((kept[i].values[s] - kept[i - 1].values[s]) * t) / k;
            }
            full.push({ values });
          }
        }
      }
      full.push(kept[i]);
    }
    return { lines: full.map((t) => t.values), step };
  };

  const hBuilt = build(hRaw, rawPitchY, hRaw.centers);
  const vBuilt = build(vRaw, rawPitchX, vRaw.centers);
  if (hBuilt.lines.length < 4 || vBuilt.lines.length < 4) return null;

  const mesh = {
    hLines: hBuilt.lines,
    vLines: vBuilt.lines,
    sampleX: hRaw.centers,
    sampleY: vRaw.centers,
    pitchY: hBuilt.step,
    pitchX: vBuilt.step,
    rows: hBuilt.lines.length - 1,
    cols: vBuilt.lines.length - 1,
    width: w,
    height: h,
  };
  mesh.nodes = computeNodes(mesh);
  return mesh;
}

function interp(values, samples, p) {
  const n = samples.length;
  if (p <= samples[0]) {
    const slope = (values[1] - values[0]) / (samples[1] - samples[0]);
    return values[0] + slope * (p - samples[0]);
  }
  if (p >= samples[n - 1]) {
    const slope = (values[n - 1] - values[n - 2]) / (samples[n - 1] - samples[n - 2]);
    return values[n - 1] + slope * (p - samples[n - 1]);
  }
  let i = 1;
  while (i < n - 1 && samples[i] < p) i++;
  const t = (p - samples[i - 1]) / (samples[i] - samples[i - 1]);
  return values[i - 1] + (values[i] - values[i - 1]) * t;
}

/** Coordonnées de tous les coins du maillage, dans un Float64Array plat. */
function computeNodes(mesh) {
  const R = mesh.hLines.length;
  const C = mesh.vLines.length;
  const nodes = new Float64Array(R * C * 2);
  for (let i = 0; i < R; i++) {
    const hv = mesh.hLines[i];
    for (let j = 0; j < C; j++) {
      const vv = mesh.vLines[j];
      let y = meanOf(hv);
      let x = interp(vv, mesh.sampleY, y);
      y = interp(hv, mesh.sampleX, x);
      x = interp(vv, mesh.sampleY, y);
      nodes[(i * C + j) * 2] = x;
      nodes[(i * C + j) * 2 + 1] = y;
    }
  }
  return nodes;
}

/**
 * Aplatit la photo d'après un maillage : chaque case du maillage est
 * rééchantillonnée vers une case carrée de `cell` pixels.
 *
 * L'intérêt n'est pas cosmétique. Une détection par bandes ne rassemble, pour
 * un trait donné, qu'une fraction de sa longueur à la fois — assez pour un
 * trait franc, trop peu pour les traits gris pâle d'une grille imprimée. Une
 * fois la page aplatie, un trait horizontal l'est sur toute la largeur : une
 * seconde détection accumule alors la preuve d'un bout à l'autre et retrouve
 * les traits que la première avait manqués.
 *
 * Le maillage de départ n'a donc pas besoin d'être complet, seulement d'être
 * juste là où il existe : il ne sert qu'à décrire la déformation.
 *
 * @returns {{canvas:HTMLCanvasElement, cell:number, toSource:(x:number,y:number)=>{x:number,y:number}}}
 */
export function flatten(photo, mesh, cell = 28) {
  const R = mesh.hLines.length - 1;
  const C = mesh.vLines.length - 1;
  const out = document.createElement('canvas');
  out.width = C * cell;
  out.height = R * cell;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';

  // Case par case : une transformation affine par case suit la courbure d'assez
  // près, les cases étant petites devant le rayon de courbure.
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const A = node(mesh, r, c);
      const B = node(mesh, r, c + 1);
      const E = node(mesh, r + 1, c);
      const m11 = (B.x - A.x) / cell;
      const m21 = (B.y - A.y) / cell;
      const m12 = (E.x - A.x) / cell;
      const m22 = (E.y - A.y) / cell;
      const det = m11 * m22 - m12 * m21;
      if (!det) continue;
      const i11 = m22 / det;
      const i12 = -m12 / det;
      const i21 = -m21 / det;
      const i22 = m11 / det;
      ctx.save();
      ctx.beginPath();
      ctx.rect(c * cell, r * cell, cell, cell);
      ctx.clip();
      ctx.setTransform(
        i11, i21, i12, i22,
        c * cell - (i11 * A.x + i12 * A.y),
        r * cell - (i21 * A.x + i22 * A.y)
      );
      ctx.drawImage(photo, 0, 0);
      ctx.restore();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  /** Ramène un point de l'image aplatie vers la photo d'origine. */
  const toSource = (x, y) => {
    const c = Math.min(C - 1, Math.max(0, Math.floor(x / cell)));
    const r = Math.min(R - 1, Math.max(0, Math.floor(y / cell)));
    return cellPoint(mesh, r, c, x / cell - c, y / cell - r);
  };
  return { canvas: out, cell, rows: R, cols: C, toSource };
}

/** Coin (i, j) du maillage. */
export function node(mesh, i, j) {
  const C = mesh.vLines.length;
  const k = (i * C + j) * 2;
  return { x: mesh.nodes[k], y: mesh.nodes[k + 1] };
}

function lerp(p, q, t) {
  return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
}

/** Point d'une case en coordonnées relatives (u, v) ∈ [0,1]². */
function cellPoint(mesh, r, c, u, v) {
  const a = node(mesh, r, c);
  const b = node(mesh, r, c + 1);
  const d = node(mesh, r + 1, c + 1);
  const e = node(mesh, r + 1, c);
  return lerp(lerp(a, b, u), lerp(e, d, u), v);
}

/** Boîte englobante d'une case, resserrée pour ignorer le quadrillage. */
export function cellBox(mesh, r, c, inset = 0.18) {
  const corners = [
    cellPoint(mesh, r, c, inset, inset),
    cellPoint(mesh, r, c, 1 - inset, inset),
    cellPoint(mesh, r, c, 1 - inset, 1 - inset),
    cellPoint(mesh, r, c, inset, 1 - inset),
  ];
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  return {
    x0: Math.max(0, Math.round(Math.min(...xs))),
    y0: Math.max(0, Math.round(Math.min(...ys))),
    x1: Math.min(mesh.width, Math.round(Math.max(...xs))),
    y1: Math.min(mesh.height, Math.round(Math.max(...ys))),
  };
}

/**
 * Découpe une case en la redressant d'après le maillage.
 *
 * Une simple boîte englobante rapporterait, sur une photo prise de biais, un
 * chiffre penché flanqué de morceaux des cases voisines. Le maillage connaît
 * les quatre coins réels de la case : une transformation affine suffit à la
 * remettre d'aplomb.
 */
export function cellCanvas(photo, mesh, r, c, inset = 0.19) {
  const A = cellPoint(mesh, r, c, inset, inset);
  const B = cellPoint(mesh, r, c, 1 - inset, inset);
  const E = cellPoint(mesh, r, c, inset, 1 - inset);
  const wpx = Math.max(1, Math.round(Math.hypot(B.x - A.x, B.y - A.y)));
  const hpx = Math.max(1, Math.round(Math.hypot(E.x - A.x, E.y - A.y)));
  const out = document.createElement('canvas');
  out.width = wpx;
  out.height = hpx;
  const ctx = out.getContext('2d', { willReadFrequently: true });

  // Transformation directe (u, v) → photo, puis son inverse pour dessiner.
  const m11 = (B.x - A.x) / wpx;
  const m21 = (B.y - A.y) / wpx;
  const m12 = (E.x - A.x) / hpx;
  const m22 = (E.y - A.y) / hpx;
  const det = m11 * m22 - m12 * m21;
  if (!det) return null;
  const i11 = m22 / det;
  const i12 = -m12 / det;
  const i21 = -m21 / det;
  const i22 = m11 / det;
  ctx.setTransform(i11, i21, i12, i22, -(i11 * A.x + i12 * A.y), -(i21 * A.x + i22 * A.y));
  ctx.drawImage(photo, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return out;
}

/** Densité d'encre de chaque case (hors traits du quadrillage). */
export function cellDensities(ink, w, h, mesh) {
  const ii = integral(ink, w, h);
  const { rows, cols } = mesh;
  const dens = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const b = cellBox(mesh, r, c);
      const area = Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
      dens[r * cols + c] = boxSum(ii, w, b.x0, b.y0, b.x1, b.y1) / area;
    }
  }
  return dens;
}

/**
 * Sépare la feuille en quatre quadrants : indices de colonnes (haut/droite),
 * indices de lignes (bas/gauche), coin vide (haut/gauche) et grille de jeu
 * (bas/droite, vide elle aussi). On retient la coupure qui maximise ce
 * contraste.
 */
export function findSplit(dens, rows, cols, minPuzzle = 4) {
  const ii = integral(dens, cols, rows);
  const mean = (c0, r0, c1, r1) =>
    boxSum(ii, cols, c0, r0, c1, r1) / Math.max(1, (c1 - c0) * (r1 - r0));
  let best = null;
  for (let sc = 1; sc <= cols - minPuzzle; sc++) {
    for (let sr = 1; sr <= rows - minPuzzle; sr++) {
      const tl = mean(0, 0, sc, sr);
      const tr = mean(sc, 0, cols, sr);
      const bl = mean(0, sr, sc, rows);
      const br = mean(sc, sr, cols, rows);
      const score = tr + bl - 3 * (tl + br);
      if (!best || score > best.score) best = { sc, sr, score, tl, tr, bl, br };
    }
  }
  return best;
}

/** Seuil d'Otsu d'un histogramme de niveaux de gris. */
function otsu(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 128;
  let bestVar = -1;
  let meanDark = 0;
  let meanLight = 255;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = t; meanDark = mB; meanLight = mF; }
  }
  return { threshold: best, contrast: meanLight - meanDark };
}

/**
 * Binarise et nettoie une case isolée.
 *
 * Un seuillage global sur la bande assemblée ne marche pas : le papier d'une
 * case est plus sombre que le fond blanc ajouté entre les cases, et la moyenne
 * locale finit par noircir la case entière. Chaque case est donc seuillée
 * séparément (Otsu), contre son propre fond.
 *
 * Le résultat est ensuite débarrassé des restes de quadrillage : on étiquette
 * les composantes connexes, on jette les éclats et les barres fines collées au
 * bord, puis on recadre sur ce qui reste. Un morceau de trait laissé dans la
 * case se lit sinon comme un « 1 » ou un « 7 » de plus.
 *
 * @returns {null|{data:ImageData, w:number, h:number}} null si la case est vide
 */
function binarizeCell(cell) {
  if (!cell) return null;
  const w = cell.width;
  const h = cell.height;
  if (w < 5 || h < 5) return null;
  const src = cell.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, p = 0; i < src.data.length; i += 4, p++) {
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
    gray[p] = r > g ? (r > b ? r : b) : (g > b ? g : b);
  }
  const { threshold, contrast } = otsu(gray);
  // Une case vide n'a pas deux populations franches : Otsu y coupe du bruit.
  if (contrast < 40) return null;

  const mask = new Uint8Array(w * h);
  let inkCount = 0;
  for (let p = 0; p < gray.length; p++) {
    if (gray[p] <= threshold) { mask[p] = 1; inkCount++; }
  }
  const ratio = inkCount / (w * h);
  if (ratio < 0.02 || ratio > 0.6) return null;

  // Composantes connexes (8-voisinage).
  const label = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let p = 0; p < w * h; p++) {
    if (!mask[p] || label[p] >= 0) continue;
    const id = comps.length;
    const comp = { id, area: 0, x0: w, y0: h, x1: 0, y1: 0, edge: false };
    label[p] = id;
    stack.push(p);
    while (stack.length) {
      const q = stack.pop();
      const qx = q % w;
      const qy = (q / w) | 0;
      comp.area++;
      if (qx < comp.x0) comp.x0 = qx;
      if (qx > comp.x1) comp.x1 = qx;
      if (qy < comp.y0) comp.y0 = qy;
      if (qy > comp.y1) comp.y1 = qy;
      if (qx === 0 || qy === 0 || qx === w - 1 || qy === h - 1) comp.edge = true;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && label[n] < 0) { label[n] = id; stack.push(n); }
        }
      }
    }
    comps.push(comp);
  }

  const minArea = Math.max(4, w * h * 0.02);
  const keep = comps.filter((c) => {
    if (c.area < minArea) return false;
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    // Barre fine collée au bord : reste de quadrillage.
    if (c.edge && (cw < w * 0.2 || ch < h * 0.2)) return false;
    // Trait traversant toute la case sur une largeur dérisoire.
    if (ch > h * 0.92 && cw < w * 0.22) return false;
    if (cw > w * 0.92 && ch < h * 0.22) return false;
    return true;
  });
  if (!keep.length) return null;

  const kept = new Set(keep.map((c) => c.id));
  let bx0 = w, by0 = h, bx1 = 0, by1 = 0;
  for (const c of keep) {
    bx0 = Math.min(bx0, c.x0); by0 = Math.min(by0, c.y0);
    bx1 = Math.max(bx1, c.x1); by1 = Math.max(by1, c.y1);
  }
  const pad = Math.max(2, Math.round(Math.min(w, h) * 0.12));
  bx0 = Math.max(0, bx0 - pad); by0 = Math.max(0, by0 - pad);
  bx1 = Math.min(w - 1, bx1 + pad); by1 = Math.min(h - 1, by1 + pad);
  const cw = bx1 - bx0 + 1;
  const ch = by1 - by0 + 1;

  const out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const p = (y + by0) * w + (x + bx0);
      const on = mask[p] && kept.has(label[p]);
      const q = (y * cw + x) * 4;
      out.data[q] = out.data[q + 1] = out.data[q + 2] = on ? 0 : 255;
      out.data[q + 3] = 255;
    }
  }
  return { data: out, w: cw, h: ch };
}

/**
 * Assemble les cases d'une ligne d'indices en une bande horizontale propre,
 * prête pour l'OCR : chiffres noirs sur fond blanc, largement espacés.
 *
 * `slots` donne l'emplacement de chaque case dans la bande : c'est lui, et non
 * le découpage en mots de l'OCR, qui sépare les nombres. L'OCR relit une
 * ligne d'indices comme un seul nombre (« 2212121 ») ; en replaçant chaque
 * caractère reconnu dans sa case d'origine, on retrouve « 2 2 1 2 1 2 1 ».
 *
 * @returns {{canvas:HTMLCanvasElement, slots:{x0:number,x1:number}[]}}
 */
export function composeStrip(canvas, mesh, cells, cellHeight = 64, gap = 44) {
  const pieces = [];
  for (const { r, c } of cells) {
    const bin = binarizeCell(cellCanvas(canvas, mesh, r, c));
    if (!bin) continue;
    const tmp = document.createElement('canvas');
    tmp.width = bin.w;
    tmp.height = bin.h;
    tmp.getContext('2d').putImageData(bin.data, 0, 0);
    pieces.push({ canvas: tmp, w: bin.w, h: bin.h });
  }
  const scales = pieces.map((p) => cellHeight / p.h);
  const widths = pieces.map((p, i) => Math.max(1, Math.round(p.w * scales[i])));
  const total = widths.reduce((a, b) => a + b, 0) + gap * (pieces.length + 1);
  const out = document.createElement('canvas');
  out.width = Math.max(1, total);
  out.height = cellHeight + gap;
  const g = out.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff';
  g.fillRect(0, 0, out.width, out.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  const slots = [];
  let x = gap;
  pieces.forEach((p, i) => {
    g.drawImage(p.canvas, 0, 0, p.w, p.h, x, gap / 2, widths[i], cellHeight);
    slots.push({ x0: x - gap / 2, x1: x + widths[i] + gap / 2 });
    x += widths[i] + gap;
  });
  return { canvas: out, slots };
}
