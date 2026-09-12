/**
 * Chaîne d'analyse d'une photo de nonogramme, de l'image aux indices.
 *
 * Ce module ne touche pas à l'interface : il est partagé par l'application et
 * par le banc de test (`tests/bench.mjs`), qui mesure ainsi exactement ce que
 * l'utilisateur exécute.
 */

import * as vision from './vision.js';
import { fitModel, modelRange, flattenByModel } from './rectify.js';

/** Taille d'une case sur l'image aplatie, en pixels. */
const CELL = 26;

/**
 * Résolutions de travail.
 *
 * La géométrie se détecte mieux en deçà de 1400 px : au-delà, une bande couvre
 * trop peu de cases, la longueur de segment exigée tombe sous la taille d'un
 * chiffre, et les blocs d'indices se mettent à ressembler à du quadrillage.
 * La lecture des chiffres, à l'inverse, profite de chaque pixel. D'où deux
 * images : l'une pour mesurer, l'autre pour lire.
 */
const WORK_DIM = 1400;
const DETAIL_DIM = 2400;

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
 *
 * En deux temps. La première passe suit les traits à leur pente locale, ce qui
 * donne un maillage souvent incomplet — les traits imprimés pâles ne
 * rassemblent, bande par bande, qu'une fraction de leur longueur. Ce maillage
 * partiel suffit à ajuster le modèle de cylindre généralisé, qui décrit la
 * déformation de la page entière. On aplatit la photo d'après lui : les traits
 * deviennent droits d'un bord à l'autre, le pas est connu exactement, et la
 * seconde passe n'a plus qu'à dire jusqu'où va le tableau.
 *
 * @returns {null|{photo:HTMLCanvasElement, ink:Uint8Array, mesh:object, split:object,
 *                 dens:Float32Array, rows:number, cols:number, flattened:boolean}}
 */
export function locateGrid(photo, ink, w, h, opts = {}) {
  const { strips, runFactor } = opts;
  const mesh = vision.detectMesh(ink, w, h, strips, runFactor);
  if (!mesh || mesh.cols < 5 || mesh.rows < 5) return null;

  const rectified = rectifyToLattice(photo, mesh, w, h, opts);
  if (rectified) {
    const dens = vision.cellDensities(ink, w, h, rectified.mesh);
    const split = vision.findSplit(dens, rectified.mesh.rows, rectified.mesh.cols);
    if (split) {
      return {
        photo,
        ink,
        mesh: rectified.mesh,
        dens,
        split,
        cols: rectified.mesh.cols - split.sc,
        rows: rectified.mesh.rows - split.sr,
        flattened: true,
      };
    }
  }

  // Repli : on se contente du maillage de la première passe.
  const dens = vision.cellDensities(ink, w, h, mesh);
  const split = vision.findSplit(dens, mesh.rows, mesh.cols);
  if (!split) return null;
  return {
    photo,
    ink,
    mesh,
    dens,
    split,
    cols: mesh.cols - split.sc,
    rows: mesh.rows - split.sr,
    flattened: false,
  };
}

/**
 * Aplatit la photo d'après le modèle, y délimite le tableau, puis ramène ce
 * quadrillage dans le repère de la photo d'origine.
 *
 * L'image aplatie ne sert qu'à la géométrie. Les cases sont ensuite découpées
 * dans la photo elle-même : un second rééchantillonnage flouterait les
 * chiffres imprimés juste avant de les donner à lire.
 */
function rectifyToLattice(photo, mesh, w, h, opts = {}) {
  const model = fitModel(mesh);
  if (!model) return null;
  const range = modelRange(model, w, h);
  const flat = flattenByModel(photo, model, range, CELL);
  if (!flat) return null;

  const { gray, w: fw, h: fh } = vision.toGray(flat.canvas);
  const flatInk = vision.adaptiveThreshold(gray, fw, fh, Math.max(8, Math.round(Math.min(fw, fh) / 45)), 9);

  // La fenêtre de recherche vaut près d'un quart de case : les rangées
  // extrapolées au-delà du maillage détecté dérivent de quelques pixels, et
  // une fenêtre trop étroite les manquait — c'est tout le bloc d'indices du
  // haut qui disparaissait alors.
  const extent = vision.latticeExtent(flatInk, fw, fh, CELL, 0.14, Math.max(2, Math.round(CELL * 0.23)));
  if (!extent) return null;
  if (extent.j1 - extent.j0 < 6 || extent.i1 - extent.i0 < 6) return null;

  // Recadrage sur le tableau, puis nouvelle détection.
  //
  // Supposer le quadrillage parfaitement régulier ne suffisait pas : le modèle
  // dérive de quelques pixels là où il extrapole, assez pour rogner le haut
  // des chiffres et faire entrer un coin de quadrillage dans les cases vides.
  // Sur l'image recadrée, les traits sont droits, entiers et sans
  // arrière-plan : les mesurer vaut mieux que les supposer.
  const margin = Math.round(CELL * 0.6);
  const x0 = Math.max(0, Math.round(extent.j0 * CELL) - margin);
  const y0 = Math.max(0, Math.round(extent.i0 * CELL) - margin);
  const x1 = Math.min(fw, Math.round(extent.j1 * CELL) + margin);
  const y1 = Math.min(fh, Math.round(extent.i1 * CELL) + margin);
  const crop = document.createElement('canvas');
  crop.width = x1 - x0;
  crop.height = y1 - y0;
  crop.getContext('2d', { willReadFrequently: true })
    .drawImage(flat.canvas, x0, y0, crop.width, crop.height, 0, 0, crop.width, crop.height);

  const cropGray = vision.toGray(crop);
  const cropInk = vision.adaptiveThreshold(
    cropGray.gray, cropGray.w, cropGray.h,
    Math.max(8, Math.round(Math.min(cropGray.w, cropGray.h) / 45)), 9
  );
  const cropMesh = vision.detectMesh(cropInk, cropGray.w, cropGray.h, opts.strips, opts.runFactor);

  const toIndex = (x, y) => ({
    i: range.i0 + (y0 + y) / CELL,
    j: range.j0 + (x0 + x) / CELL,
  });

  if (cropMesh && cropMesh.cols >= 6 && cropMesh.rows >= 6) {
    const sourceMesh = vision.meshFromNodes(
      cropMesh.rows, cropMesh.cols,
      (i, j) => {
        const p = vision.node(cropMesh, i, j);
        const k = toIndex(p.x, p.y);
        return model.node(k.i, k.j);
      },
      w, h
    );
    return { mesh: sourceMesh, model, flat };
  }

  // Repli : le réseau régulier, recalé sur la tendance des décalages mesurés.
  const cols = extent.j1 - extent.j0;
  const rows = extent.i1 - extent.i0;
  const sourceMesh = vision.meshFromNodes(
    rows, cols,
    (i, j) => model.node(
      range.i0 + extent.i0 + i + extent.offsetH[extent.i0 + i] / CELL,
      range.j0 + extent.j0 + j + extent.offsetV[extent.j0 + j] / CELL
    ),
    w, h
  );
  return { mesh: sourceMesh, model, flat };
}

/**
 * Énumère les cases d'indices, dans l'ordre de lecture.
 *
 * Toutes les cases du bloc sont rendues, y compris les vides. Décider ici
 * qu'une case est vide sur un seuil de densité global s'est révélé fragile :
 * sur une photo un peu terne, les indices du haut passaient sous le seuil et
 * disparaissaient. Le tri revient à `composeStrip`, qui juge chaque case sur
 * son propre contraste, au moment où il la binarise.
 */
export function clueCells({ mesh, split, rows, cols }) {
  const rowCells = [];
  for (let r = 0; r < rows; r++) {
    const cells = [];
    for (let c = 0; c < split.sc; c++) cells.push({ r: split.sr + r, c });
    rowCells.push(cells);
  }
  const colCells = [];
  for (let c = 0; c < cols; c++) {
    const cells = [];
    for (let r = 0; r < split.sr; r++) cells.push({ r, c: split.sc + c });
    colCells.push(cells);
  }
  return { rowCells, colCells };
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
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source image d'origine
 * @param {object} opts
 * @param {() => Promise<object>} opts.getWorker fournit le worker OCR
 * @param {(p:{text:string, value:number}) => void} [opts.onProgress]
 * @param {() => boolean} [opts.cancelled]
 * @param {object} opts.ocr module de lecture (injecté pour le test)
 */
export async function analyzePhoto(source, opts) {
  const { getWorker, ocr, onProgress = () => {}, cancelled = () => false } = opts;

  onProgress({ text: 'Préparation de l’image…', value: 0.05 });
  await nextTick();
  const work = vision.toWorkingCanvas(source, opts.workDim || WORK_DIM);
  const detail = vision.toWorkingCanvas(source, opts.detailDim || DETAIL_DIM);
  const detailScale = detail.width / work.width;
  const { photo, ink, w, h } = prepare(work);

  onProgress({ text: 'Détection du quadrillage…', value: 0.15 });
  await nextTick();
  const located = locateGrid(photo, ink, w, h);
  if (!located) return { photo, error: 'grid-not-found' };

  const { mesh, split, rows, cols } = located;
  const { rowCells, colCells } = clueCells(located);

  const result = {
    split,
    // L'image de travail est la photo redressée quand la rectification a
    // abouti : la superposition y tombe juste par construction.
    photo: located.photo,
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
      const strip = vision.composeStrip(detail, mesh, cells, 64, 44, detailScale);
      const read = strip.slots.length
        ? await ocr.readStrip(worker, strip)
        : { values: [], confidence: 0, minConfidence: 0 };
      // Un indice plus grand que la ligne ne peut pas exister : la case est
      // relue en « mot isolé », mode mieux adapté aux nombres à deux chiffres
      // que le livre imprime en corps réduit — « 16 » y ressortait « 146 ».
      for (let k = 0; k < read.values.length; k++) {
        if (read.values[k] === null || read.values[k] <= lineLength) continue;
        const cell = strip.slots[k] && strip.slots[k].cell;
        if (!cell) continue;
        const again = await ocr.readCell(worker, cell, '8');
        if (again !== null && again <= lineLength) read.values[k] = again;
      }
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
