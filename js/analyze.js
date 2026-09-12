/**
 * Chaîne d'analyse d'une photo de nonogramme, de l'image aux indices.
 *
 * Ce module ne touche pas à l'interface : il est partagé par l'application et
 * par le banc de test (`tests/bench.mjs`), qui mesure ainsi exactement ce que
 * l'utilisateur exécute.
 */

import * as vision from './vision.js';

/**
 * Extrait le masque d'encre de la photo.
 *
 * Aucun redressement global : le maillage suit les traits à leur pente locale
 * et chaque case est redressée d'après lui, ce qui traite l'inclinaison et le
 * bombement de la page ensemble.
 */
export function prepare(sourceCanvas) {
  const photo = sourceCanvas;
  const { gray, w, h } = vision.toGray(photo);
  const radius = Math.max(8, Math.round(Math.min(w, h) / 45));
  const ink = vision.adaptiveThreshold(gray, w, h, radius, 9);
  return { photo, ink, w, h };
}

/**
 * Localise le tableau et sépare les blocs d'indices de la grille de jeu.
 * @returns {null|{mesh:object, split:object, dens:Float32Array, rows:number, cols:number}}
 */
export function locateGrid(ink, w, h) {
  const mesh = vision.detectMesh(ink, w, h);
  if (!mesh || mesh.cols < 5 || mesh.rows < 5) return null;
  const dens = vision.cellDensities(ink, w, h, mesh);
  const split = vision.findSplit(dens, mesh.rows, mesh.cols);
  if (!split) return null;
  return {
    mesh,
    split,
    dens,
    cols: mesh.cols - split.sc,
    rows: mesh.rows - split.sr,
  };
}

/**
 * Repère les cases d'indices non vides, ligne par ligne et colonne par
 * colonne, dans l'ordre de lecture.
 */
export function clueCells({ mesh, split, dens, rows, cols }) {
  // Seuil « case non vide » : une fraction de la densité moyenne des cases
  // franchement encrées, pour rester valable quel que soit le contraste.
  const clueDens = [];
  for (let r = 0; r < mesh.rows; r++) {
    for (let c = 0; c < mesh.cols; c++) {
      const inTop = r < split.sr && c >= split.sc;
      const inLeft = r >= split.sr && c < split.sc;
      if (inTop || inLeft) clueDens.push(dens[r * mesh.cols + c]);
    }
  }
  clueDens.sort((a, b) => b - a);
  const strong = clueDens.slice(0, Math.max(1, Math.round(clueDens.length * 0.35)));
  const threshold = Math.max(
    0.012,
    (strong.reduce((a, b) => a + b, 0) / strong.length) * 0.38
  );

  const rowCells = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let c = 0; c < split.sc; c++) {
      if (dens[(split.sr + r) * mesh.cols + c] >= threshold) cells.push({ r: split.sr + r, c });
    }
    rowCells.push(cells);
  }
  const colCells = [];
  for (let c = 0; c < cols; c++) {
    const cells = [];
    for (let r = 0; r < split.sr; r++) {
      if (dens[r * mesh.cols + split.sc + c] >= threshold) cells.push({ r, c: split.sc + c });
    }
    colCells.push(cells);
  }
  return { rowCells, colCells, threshold };
}

/**
 * Une ligne d'indices est suspecte si une case n'a rien donné, si l'OCR
 * hésite, ou si les indices lus ne peuvent pas tenir dans la ligne.
 */
export function isDoubtful(read, clues, lineLength) {
  if (!read.values.length) return true;
  if (read.values.some((v) => v === null)) return true;
  if (clues.some((v) => v > lineLength)) return true;
  const minLen = clues.reduce((a, b) => a + b, 0) + Math.max(0, clues.length - 1);
  if (minLen > lineLength) return true;
  return read.minConfidence < 85;
}

/**
 * Analyse complète : photo → indices.
 *
 * @param {HTMLCanvasElement} sourceCanvas
 * @param {object} opts
 * @param {() => Promise<object>} opts.getWorker fournit le worker OCR
 * @param {(p:{text:string, value:number}) => void} [opts.onProgress]
 * @param {() => boolean} [opts.cancelled]
 * @param {object} opts.ocr module de lecture (injecté pour le test)
 */
export async function analyzePhoto(sourceCanvas, opts) {
  const { getWorker, ocr, onProgress = () => {}, cancelled = () => false } = opts;

  onProgress({ text: 'Redressement de l’image…', value: 0.05 });
  await nextTick();
  const { photo, ink, w, h } = prepare(sourceCanvas);

  onProgress({ text: 'Détection du quadrillage…', value: 0.15 });
  await nextTick();
  const located = locateGrid(ink, w, h);
  if (!located) return { photo, error: 'grid-not-found' };

  const { mesh, split, rows, cols } = located;
  const { rowCells, colCells } = clueCells(located);

  const result = {
    photo,
    mesh,
    split,
    rows,
    cols,
    rowClues: rowCells.map(() => []),
    colClues: colCells.map(() => []),
    doubtRows: new Set(),
    doubtCols: new Set(),
  };

  let worker;
  try {
    onProgress({ text: 'Chargement du moteur de lecture…', value: 0.2 });
    worker = await getWorker();
  } catch (err) {
    result.error = 'ocr-unavailable';
    result.errorMessage = (err && err.message) || 'Moteur de reconnaissance indisponible.';
    return result;
  }

  const total = rowCells.length + colCells.length;
  let done = 0;

  const readGroup = async (groups, out, doubt, label, lineLength) => {
    for (let i = 0; i < groups.length; i++) {
      if (cancelled()) return;
      const cells = groups[i];
      if (!cells.length) { out[i] = []; doubt.add(i); done++; continue; }
      const strip = vision.composeStrip(photo, mesh, cells);
      const read = strip.slots.length
        ? await ocr.readStrip(worker, strip)
        : { values: [], confidence: 0, minConfidence: 0 };
      const clues = read.values.filter((v) => v !== null);
      out[i] = clues;
      if (isDoubtful(read, clues, lineLength)) doubt.add(i);
      done++;
      onProgress({
        text: `Lecture des indices ${label} ${i + 1}/${groups.length}…`,
        value: 0.3 + (done / total) * 0.68,
      });
      if (i % 3 === 0) await nextTick();
    }
  };

  await readGroup(rowCells, result.rowClues, result.doubtRows, 'de lignes', cols);
  await readGroup(colCells, result.colClues, result.doubtCols, 'de colonnes', rows);
  return result;
}

function nextTick() {
  return typeof requestAnimationFrame === 'function'
    ? new Promise((r) => requestAnimationFrame(() => r()))
    : Promise.resolve();
}
