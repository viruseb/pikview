/**
 * Rectification par cylindre généralisé.
 *
 * Une feuille de papier est une surface développable : on la plie, on ne
 * l'étire pas, sa courbure de Gauss est nulle partout. Elle n'a donc qu'un
 * seul degré de liberté de courbure, et elle est réglée — engendrée par une
 * famille de droites, les règles, qui restent droites en 3D et se projettent
 * donc en droites dans l'image.
 *
 * En notant (X, Y) les coordonnées sur la page, Y le long des règles, la
 * surface s'écrit (X, Y, g(X)). Un point de l'image vaut alors, en
 * coordonnées homogènes :
 *
 *     p(X, Y) ∝ X·c₁ + Y·c₂ + g(X)·c₃ + c₄
 *
 * où les cᵢ sont les colonnes de la matrice de caméra. Le terme en Y ne
 * dépend pas de X : c₂ est le point de fuite commun à toutes les règles.
 *
 * En envoyant ce point de fuite à l'infini vertical par une homographie H, le
 * modèle se réduit à deux énoncés élémentaires — et vérifiables :
 *
 *   1. x′ ne dépend que de l'indice de règle ;
 *   2. y′ est une fonction *affine* de l'indice transversal, le long de
 *      chaque règle.
 *
 * Plus de pose 3D, plus de focale, plus d'optimisation non linéaire : deux
 * ajustements linéaires. Et surtout le second est exact, ce qui permet
 * d'extrapoler sans risque les traits que la détection locale a manqués.
 */

import { node } from './vision.js';

/* ---------------------------------------------------------------- algèbre */

function matMul(A, B) {
  const C = new Float64Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += A[i * 3 + k] * B[k * 3 + j];
      C[i * 3 + j] = s;
    }
  }
  return C;
}

function matApply(M, x, y) {
  const w = M[6] * x + M[7] * y + M[8];
  return { x: (M[0] * x + M[1] * y + M[2]) / w, y: (M[3] * x + M[4] * y + M[5]) / w, w };
}

function matInverse(M) {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) return null;
  const inv = new Float64Array([
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ]);
  for (let k = 0; k < 9; k++) inv[k] /= det;
  return inv;
}

/** Vecteur propre associé à la plus petite valeur propre (matrice 3×3 symétrique). */
function smallestEigenvector(m) {
  // Rotations de Jacobi : la matrice est minuscule, la simplicité prime.
  const a = Float64Array.from(m);
  const v = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  for (let sweep = 0; sweep < 24; sweep++) {
    let p = 0, q = 1, best = Math.abs(a[1]);
    if (Math.abs(a[2]) > best) { best = Math.abs(a[2]); p = 0; q = 2; }
    if (Math.abs(a[5]) > best) { best = Math.abs(a[5]); p = 1; q = 2; }
    if (best < 1e-14) break;
    const app = a[p * 3 + p], aqq = a[q * 3 + q], apq = a[p * 3 + q];
    const theta = 0.5 * Math.atan2(2 * apq, aqq - app);
    const c = Math.cos(theta), s = Math.sin(theta);
    for (let k = 0; k < 3; k++) {
      const akp = a[k * 3 + p], akq = a[k * 3 + q];
      a[k * 3 + p] = c * akp - s * akq;
      a[k * 3 + q] = s * akp + c * akq;
    }
    for (let k = 0; k < 3; k++) {
      const apk = a[p * 3 + k], aqk = a[q * 3 + k];
      a[p * 3 + k] = c * apk - s * aqk;
      a[q * 3 + k] = s * apk + c * aqk;
    }
    for (let k = 0; k < 3; k++) {
      const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
      v[k * 3 + p] = c * vkp - s * vkq;
      v[k * 3 + q] = s * vkp + c * vkq;
    }
  }
  let idx = 0;
  let min = a[0];
  if (a[4] < min) { min = a[4]; idx = 1; }
  if (a[8] < min) { min = a[8]; idx = 2; }
  return [v[idx], v[3 + idx], v[6 + idx]];
}

/* ----------------------------------------------------------- ajustements */

/**
 * Droite des moindres carrés totaux d'un nuage de points.
 * @returns {{a:number,b:number,c:number,rms:number}} ax + by + c = 0, a² + b² = 1
 */
export function fitLine(points) {
  const n = points.length;
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  // Vecteur propre minimal de la covariance : la normale à la droite.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const a = -Math.sin(theta), b = Math.cos(theta);
  const c = -(a * mx + b * my);
  let ss = 0;
  for (const p of points) { const e = a * p.x + b * p.y + c; ss += e * e; }
  return { a, b, c, rms: Math.sqrt(ss / n) };
}

/** Régression affine y = p·t + q. */
function fitAffine(ts, ys) {
  const n = ts.length;
  let st = 0, sy = 0, stt = 0, sty = 0;
  for (let i = 0; i < n; i++) { st += ts[i]; sy += ys[i]; stt += ts[i] * ts[i]; sty += ts[i] * ys[i]; }
  const det = n * stt - st * st;
  if (!det) return { p: 0, q: sy / n, rms: Infinity };
  const p = (n * sty - st * sy) / det;
  const q = (sy - p * st) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) { const e = ys[i] - (p * ts[i] + q); ss += e * e; }
  return { p, q, rms: Math.sqrt(ss / n) };
}

/** Ajustement polynomial par moindres carrés (équations normales, degré ≤ 4). */
export function fitPoly(ts, ys, degree) {
  const d = Math.min(degree, Math.max(1, ts.length - 1));
  const m = d + 1;
  const A = new Float64Array(m * m);
  const rhs = new Float64Array(m);
  for (let k = 0; k < ts.length; k++) {
    const pow = new Float64Array(m);
    pow[0] = 1;
    for (let i = 1; i < m; i++) pow[i] = pow[i - 1] * ts[k];
    for (let i = 0; i < m; i++) {
      rhs[i] += pow[i] * ys[k];
      for (let j = 0; j < m; j++) A[i * m + j] += pow[i] * pow[j];
    }
  }
  // Élimination de Gauss avec pivot partiel.
  for (let i = 0; i < m; i++) {
    let piv = i;
    for (let r = i + 1; r < m; r++) if (Math.abs(A[r * m + i]) > Math.abs(A[piv * m + i])) piv = r;
    if (Math.abs(A[piv * m + i]) < 1e-12) return null;
    if (piv !== i) {
      for (let c = 0; c < m; c++) { const t = A[i * m + c]; A[i * m + c] = A[piv * m + c]; A[piv * m + c] = t; }
      const t = rhs[i]; rhs[i] = rhs[piv]; rhs[piv] = t;
    }
    for (let r = i + 1; r < m; r++) {
      const f = A[r * m + i] / A[i * m + i];
      if (!f) continue;
      for (let c = i; c < m; c++) A[r * m + c] -= f * A[i * m + c];
      rhs[r] -= f * rhs[i];
    }
  }
  const coef = new Float64Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = rhs[i];
    for (let j = i + 1; j < m; j++) s -= A[i * m + j] * coef[j];
    coef[i] = s / A[i * m + i];
  }
  const evaluate = (t) => {
    let s = 0;
    for (let i = m - 1; i >= 0; i--) s = s * t + coef[i];
    return s;
  };
  let ss = 0;
  for (let k = 0; k < ts.length; k++) { const e = ys[k] - evaluate(ts[k]); ss += e * e; }
  return { coef, evaluate, rms: Math.sqrt(ss / ts.length) };
}

/* -------------------------------------------------------------- le modèle */

/** Extrait les nœuds du maillage sous forme de tableau [i][j]. */
function meshPoints(mesh) {
  const R = mesh.hLines.length;
  const C = mesh.vLines.length;
  const pts = [];
  for (let i = 0; i < R; i++) {
    const row = [];
    for (let j = 0; j < C; j++) row.push(node(mesh, i, j));
    pts.push(row);
  }
  return pts;
}

/**
 * Détermine quelle famille de traits porte les règles : celle qui reste
 * droite dans l'image.
 */
export function rulingFamily(pts) {
  const R = pts.length;
  const C = pts[0].length;
  const rmsOf = (lines) => {
    const all = lines.map((p) => fitLine(p).rms).sort((a, b) => a - b);
    return all[all.length >> 1];
  };
  const horizontal = [];
  for (let i = 0; i < R; i++) horizontal.push(pts[i]);
  const vertical = [];
  for (let j = 0; j < C; j++) vertical.push(pts.map((row) => row[j]));
  const rmsH = rmsOf(horizontal);
  const rmsV = rmsOf(vertical);
  return rmsV <= rmsH
    ? { axis: 'vertical', lines: vertical, rms: rmsV, other: rmsH }
    : { axis: 'horizontal', lines: horizontal, rms: rmsH, other: rmsV };
}

/** Point de fuite commun à un faisceau de droites. */
export function vanishingPoint(lines) {
  const m = new Float64Array(9);
  for (const l of lines) {
    const v = [l.a, l.b, l.c];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += v[i] * v[j];
  }
  const V = smallestEigenvector(m);
  // Erreur de concourance : distance du point de fuite à chaque droite.
  let ss = 0;
  const norm = Math.hypot(V[0], V[1], V[2]) || 1;
  const v = V.map((t) => t / norm);
  for (const l of lines) {
    const d = l.a * v[0] + l.b * v[1] + l.c * v[2];
    ss += d * d;
  }
  return { V: v, rms: Math.sqrt(ss / lines.length) };
}

/**
 * Homographie envoyant le point de fuite à l'infini vertical.
 *
 * Les règles deviennent alors des verticales parallèles, ce qui rend le
 * modèle lisible : abscisse constante le long d'une règle, ordonnée affine en
 * l'indice transversal.
 */
export function rectifyingHomography(V, cx, cy) {
  // Recentrage sur l'image, pour que la transformation reste bien conditionnée.
  const T = new Float64Array([1, 0, -cx, 0, 1, -cy, 0, 0, 1]);
  const Tinv = new Float64Array([1, 0, cx, 0, 1, cy, 0, 0, 1]);

  // Point de fuite dans le repère recentré.
  const vx = V[0] - cx * V[2];
  const vy = V[1] - cy * V[2];
  const vw = V[2];

  const dirLen = Math.hypot(vx, vy) || 1;
  const ux = vx / dirLen;
  const uy = vy / dirLen;
  // Rotation amenant la direction du point de fuite sur l'axe +y.
  const Rot = new Float64Array([uy, -ux, 0, ux, uy, 0, 0, 0, 1]);

  // Distance du point de fuite, une fois tourné : (0, dirLen/vw).
  // Quand elle est grande — perspective faible — la transformation tend vers
  // l'identité et l'on retombe sur une simple rotation.
  const dist = Math.abs(vw) > 1e-12 ? dirLen / vw : Infinity;
  const K = Number.isFinite(dist) && Math.abs(dist) > 1e-6
    ? new Float64Array([1, 0, 0, 0, 1, 0, 0, -1 / dist, 1])
    : new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  const H = matMul(K, matMul(Rot, T));
  // Recentrage de sortie, pour garder des coordonnées de l'ordre de l'image.
  const out = matMul(Tinv, H);
  return { H: out, Hinv: matInverse(out), vanishingDistance: dist };
}

/**
 * Ajuste le modèle complet sur un maillage détecté.
 *
 * @returns {null|object} le modèle, avec ses résidus de validation
 */
export function fitModel(mesh) {
  const pts = meshPoints(mesh);
  if (pts.length < 4 || pts[0].length < 4) return null;

  const family = rulingFamily(pts);
  const fitted = family.lines.map((p) => fitLine(p));
  const vp = vanishingPoint(fitted);
  const { H, Hinv, vanishingDistance } = rectifyingHomography(
    vp.V, mesh.width / 2, mesh.height / 2
  );
  if (!Hinv) return null;

  // Coordonnées rectifiées : k indice de règle, t indice transversal.
  const nRulings = family.lines.length;
  const nCross = family.lines[0].length;
  const rect = [];
  for (let k = 0; k < nRulings; k++) {
    rect.push(family.lines[k].map((p) => matApply(H, p.x, p.y)));
  }

  // Vérification 1 : x′ constant le long d'une règle.
  // Vérification 2 : y′ affine en l'indice transversal.
  const ts = Array.from({ length: nCross }, (_, t) => t);
  const xs = [];
  const slopes = [];
  const intercepts = [];
  let xRms = 0;
  let affineRms = 0;
  for (let k = 0; k < nRulings; k++) {
    const line = rect[k];
    let mean = 0;
    for (const p of line) mean += p.x;
    mean /= nCross;
    let ss = 0;
    for (const p of line) ss += (p.x - mean) * (p.x - mean);
    xRms += Math.sqrt(ss / nCross);
    xs.push(mean);

    const aff = fitAffine(ts, line.map((p) => p.y));
    slopes.push(aff.p);
    intercepts.push(aff.q);
    affineRms += aff.rms;
  }
  xRms /= nRulings;
  affineRms /= nRulings;

  // Les trois profils varient lentement d'une règle à l'autre. Ils servent
  // uniquement à *prolonger* le modèle au-delà des règles détectées : là où
  // l'on a mesuré, on garde la mesure, un lissage ne ferait qu'y ajouter son
  // propre biais. Le degré 3 était trop bas — l'erreur de reprojection prenait
  // une forme en U caractéristique, faible au centre et croissante aux bords.
  const ks = Array.from({ length: nRulings }, (_, k) => k);
  const profileX = fitPoly(ks, xs, 4);
  const profileSlope = fitPoly(ks, slopes, 4);
  const profileIntercept = fitPoly(ks, intercepts, 4);
  if (!profileX || !profileSlope || !profileIntercept) return null;

  /** Valeur d'un profil : mesurée dans la plage détectée, prolongée au-delà. */
  const sample = (measured, poly) => (k) => {
    if (k <= 0) return k === 0 ? measured[0] : poly.evaluate(k);
    if (k >= nRulings - 1) return k === nRulings - 1 ? measured[nRulings - 1] : poly.evaluate(k);
    const lo = Math.floor(k);
    const f = k - lo;
    return measured[lo] * (1 - f) + measured[lo + 1] * f;
  };
  const atX = sample(xs, profileX);
  const atSlope = sample(slopes, profileSlope);
  const atIntercept = sample(intercepts, profileIntercept);

  /**
   * Position image d'un nœud du réseau. Les indices peuvent être réels et
   * sortir de la plage détectée : le long d'une règle l'extrapolation est
   * exacte, puisque la relation y est affine.
   */
  const project = (k, t) => matApply(Hinv, atX(k), atIntercept(k) + atSlope(k) * t);

  /** Même chose, en indices (ligne, colonne) du maillage d'origine. */
  const node2 = family.axis === 'vertical'
    ? (i, j) => project(j, i)
    : (i, j) => project(i, j);

  return {
    axis: family.axis,
    H,
    Hinv,
    vanishingPoint: vp.V,
    vanishingDistance,
    project,
    node: node2,
    nRulings,
    nCross,
    rows: family.axis === 'vertical' ? nCross : nRulings,
    cols: family.axis === 'vertical' ? nRulings : nCross,
    residuals: {
      straightness: family.rms,
      straightnessOther: family.other,
      concurrency: vp.rms,
      abscissa: xRms,
      affine: affineRms,
    },
  };
}

/**
 * Étend la plage d'indices tant que les nœuds prédits restent dans l'image.
 *
 * Le maillage détecté s'arrête souvent avant le bord du tableau, là où les
 * traits pâlissent. Le modèle, lui, sait où seraient les suivants.
 */
export function modelRange(model, width, height, maxExtra = 20) {
  const inside = (p) => p.x >= -2 && p.y >= -2 && p.x <= width + 2 && p.y <= height + 2;
  const rows = model.rows;
  const cols = model.cols;
  const probe = (i, j) => model.node(i, j);
  const edgeOk = (i0, i1, j0, j1) => {
    // Un bord est admis si une bonne partie de ses nœuds tombe dans l'image.
    const corners = [probe(i0, j0), probe(i0, j1), probe(i1, j0), probe(i1, j1)];
    return corners.filter(inside).length >= 3;
  };
  let i0 = 0, i1 = rows - 1, j0 = 0, j1 = cols - 1;
  for (let n = 0; n < maxExtra && edgeOk(i0 - 1, i1, j0, j1); n++) i0--;
  for (let n = 0; n < maxExtra && edgeOk(i0, i1 + 1, j0, j1); n++) i1++;
  for (let n = 0; n < maxExtra && edgeOk(i0, i1, j0 - 1, j1); n++) j0--;
  for (let n = 0; n < maxExtra && edgeOk(i0, i1, j0, j1 + 1); n++) j1++;
  return { i0, i1, j0, j1 };
}

/**
 * Rééchantillonne la photo sur le réseau prédit par le modèle.
 *
 * Une fois la page à plat, un trait horizontal l'est sur toute la largeur :
 * une seconde détection accumule la preuve d'un bout à l'autre de l'image, au
 * lieu d'une bande à la fois, et retrouve les traits pâles que la détection
 * locale avait manqués.
 */
export function flattenByModel(photo, model, range, cell = 26) {
  const cols = range.j1 - range.j0;
  const rows = range.i1 - range.i0;
  if (cols < 2 || rows < 2) return null;
  const out = document.createElement('canvas');
  out.width = cols * cell;
  out.height = rows * cell;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingQuality = 'high';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const A = model.node(range.i0 + r, range.j0 + c);
      const B = model.node(range.i0 + r, range.j0 + c + 1);
      const E = model.node(range.i0 + r + 1, range.j0 + c);
      const m11 = (B.x - A.x) / cell;
      const m21 = (B.y - A.y) / cell;
      const m12 = (E.x - A.x) / cell;
      const m22 = (E.y - A.y) / cell;
      const det = m11 * m22 - m12 * m21;
      if (!det) continue;
      const i11 = m22 / det, i12 = -m12 / det, i21 = -m21 / det, i22 = m11 / det;
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
  const toSource = (x, y) => model.node(range.i0 + y / cell, range.j0 + x / cell);
  return { canvas: out, cell, range, toSource };
}
