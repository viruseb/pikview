import * as camera from './camera.js';
import * as vision from './vision.js';
import * as ocr from './ocr.js';
import * as overlay from './overlay.js';
import { analyzePhoto } from './analyze.js';

const $ = (id) => document.getElementById(id);

const el = {
  screens: {
    capture: $('screen-capture'),
    review: $('screen-review'),
    result: $('screen-result'),
  },
  video: $('video'),
  cameraError: $('camera-error'),
  fileInput: $('file-input'),
  detectCanvas: $('detect-canvas'),
  resultCanvas: $('result-canvas'),
  rowClues: $('row-clues'),
  colClues: $('col-clues'),
  rowsSum: $('rows-sum'),
  colsSum: $('cols-sum'),
  sumStatus: $('sum-status'),
  resultStatus: $('result-status'),
  inRows: $('in-rows'),
  inCols: $('in-cols'),
  busy: $('busy'),
  busyText: $('busy-text'),
  busyBar: $('busy-bar'),
  opacity: $('in-opacity'),
  chkPhoto: $('chk-photo'),
  chkAdjust: $('chk-adjust'),
};

const state = {
  photo: null,        // canvas redressé, référentiel de toutes les coordonnées
  mesh: null,         // maillage détecté (polylignes + nœuds)
  split: null,        // { sc, sr } : largeur du bloc d'indices gauche / haut
  rows: 0,
  cols: 0,
  rowClues: [],
  colClues: [],
  doubt: { rows: new Set(), cols: new Set() },
  // Lecture concurrente, là où les deux méthodes de reconnaissance divergent.
  alt: { rows: new Map(), cols: new Map() },
  // Vignette de chaque ligne d'indices, telle qu'elle a été lue.
  images: { rows: [], cols: [] },
  quad: null,         // 4 coins ajustés à la main, référentiel photo
  useQuad: false,     // true dès que l'utilisateur déplace un coin
  solution: null,
};

/** Projection (u, v) → pixel de la photo, pour la grille de jeu. */
function currentMapper() {
  if (!state.useQuad && state.mesh && state.split) {
    return overlay.meshMapper(state.mesh, state.split.sr, state.split.sc);
  }
  return overlay.quadMapper(state.quad);
}

let cancelled = false;
let solverWorker = null;

/* ------------------------------------------------------------------ écrans */

function show(name) {
  for (const [key, node] of Object.entries(el.screens)) {
    node.classList.toggle('active', key === name);
  }
  window.scrollTo(0, 0);
  if (name === 'capture') startCamera();
  else camera.stop();
}

function busy(text, progress) {
  el.busy.hidden = false;
  el.busyText.textContent = text;
  el.busyBar.style.width = progress == null ? '0%' : `${Math.round(progress * 100)}%`;
}

function idle() {
  el.busy.hidden = true;
}

/* ------------------------------------------------------------------ caméra */

async function startCamera() {
  el.cameraError.hidden = true;
  if (!camera.isSupported()) {
    el.cameraError.hidden = false;
    el.cameraError.textContent =
      "La caméra n'est pas accessible sur cet appareil. Utilisez « Galerie » pour choisir une photo.";
    return;
  }
  try {
    await camera.start(el.video);
    $('btn-torch').hidden = !camera.torchSupported();
  } catch (err) {
    el.cameraError.hidden = false;
    el.cameraError.textContent =
      err && err.name === 'NotAllowedError'
        ? "Accès à la caméra refusé. Autorisez-le dans les réglages du navigateur, ou utilisez « Galerie »."
        : `Caméra indisponible (${err && err.name ? err.name : 'erreur'}). Utilisez « Galerie ».`;
  }
}

/* ----------------------------------------------------------------- analyse */

async function analyze(sourceCanvas) {
  cancelled = false;
  const result = await analyzePhoto(sourceCanvas, {
    ocr,
    getWorker: () =>
      ocr.getWorker((m) => {
        if (m.status && m.status.includes('loading')) {
          busy('Chargement du moteur de lecture…', 0.2 + (m.progress || 0) * 0.1);
        }
      }),
    onProgress: ({ text, value }) => busy(text, value),
    cancelled: () => cancelled,
  });

  state.photo = result.photo || null;

  if (result.error === 'grid-not-found') {
    idle();
    alert(
      'Quadrillage introuvable. Reprenez la photo bien à plat, avec un bon éclairage ' +
      'et toute la grille dans le cadre — ou utilisez la saisie manuelle.'
    );
    return false;
  }

  state.mesh = result.mesh;
  state.split = result.split;
  state.rows = result.rows;
  state.cols = result.cols;
  state.rowClues = result.rowClues;
  state.colClues = result.colClues;
  state.doubt.rows = result.doubtRows;
  state.doubt.cols = result.doubtCols;
  state.alt.rows = result.altRows || new Map();
  state.alt.cols = result.altCols || new Map();
  state.images.rows = result.rowImages || [];
  state.images.cols = result.colImages || [];
  state.quad = overlay.quadFromMesh(result.mesh, result.split.sr, result.split.sc);
  state.useQuad = false;

  drawDetection();
  idle();

  if (result.error === 'ocr-unavailable') {
    buildEditor();
    show('review');
    alert(
      `${result.errorMessage}\n\nLes indices n'ont pas pu être lus automatiquement : ` +
      'saisissez-les à la main ci-dessous. La grille détectée reste utilisée pour la superposition.'
    );
    return true;
  }

  if (cancelled) return false;
  buildEditor();
  show('review');
  return true;
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/* ----------------------------------------------- aperçu de la détection */

function drawDetection() {
  const { photo, mesh, split } = state;
  const canvas = el.detectCanvas;
  if (!photo || !mesh) { canvas.width = canvas.height = 0; return; }
  const maxW = Math.min(window.innerWidth - 16, 900);
  const scale = Math.min(1, maxW / photo.width);
  canvas.width = Math.round(photo.width * scale);
  canvas.height = Math.round(photo.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(photo, 0, 0, canvas.width, canvas.height);
  const R = mesh.hLines.length;
  const C = mesh.vLines.length;
  const P = (i, j) => {
    const p = vision.node(mesh, i, j);
    return { x: p.x * scale, y: p.y * scale };
  };
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(76,141,255,0.5)';
  for (let i = 0; i < R; i++) {
    ctx.beginPath();
    for (let j = 0; j < C; j++) { const p = P(i, j); j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
    ctx.stroke();
  }
  for (let j = 0; j < C; j++) {
    ctx.beginPath();
    for (let i = 0; i < R; i++) { const p = P(i, j); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
    ctx.stroke();
  }
  if (split) {
    ctx.strokeStyle = '#3ddc84';
    ctx.lineWidth = 3;
    ctx.beginPath();
    const corners = [P(split.sr, split.sc), P(split.sr, C - 1), P(R - 1, C - 1), P(R - 1, split.sc)];
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let k = 1; k < 4; k++) ctx.lineTo(corners[k].x, corners[k].y);
    ctx.closePath();
    ctx.stroke();
  }
}

/* --------------------------------------------------- éditeur d'indices */

function parseClues(text) {
  return text
    .split(/[^0-9]+/)
    .filter(Boolean)
    .map((n) => parseInt(n, 10))
    .filter((n) => n > 0);
}

function buildEditor() {
  el.inRows.value = state.rows;
  el.inCols.value = state.cols;
  renderClueList(el.rowClues, state.rowClues, 'L', state.doubt.rows, state.alt.rows, state.images.rows, (i, v) => {
    state.rowClues[i] = v;
  });
  renderClueList(el.colClues, state.colClues, 'C', state.doubt.cols, state.alt.cols, state.images.cols, (i, v) => {
    state.colClues[i] = v;
  });
  updateSums();
}

function renderClueList(container, clues, prefix, doubtSet, altMap, images, onChange) {
  container.textContent = '';
  clues.forEach((line, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'clue' + (doubtSet.has(i) ? ' doubt' : '');
    const label = document.createElement('span');
    label.textContent = `${prefix}${i + 1}`;

    // La bande telle que l'OCR l'a vue, au-dessus du champ : c'est elle qui
    // permet de trancher sans rouvrir le magazine.
    const source = images && images[i];
    if (source) {
      const img = document.createElement('img');
      img.className = 'scan';
      img.src = source;
      img.alt = `Indices lus pour ${prefix}${i + 1}`;
      img.loading = 'lazy';
      wrap.append(img);
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.value = line.join(' ');
    input.addEventListener('input', () => {
      onChange(i, parseClues(input.value));
      wrap.classList.remove('doubt');
      doubtSet.delete(i);
      updateSums();
    });
    wrap.append(label, input);

    // Les deux lectures ont divergé : la concurrente est proposée d'un geste.
    const alternative = altMap && altMap.get(i);
    if (alternative && alternative.length) {
      const swap = document.createElement('button');
      swap.type = 'button';
      swap.className = 'alt';
      swap.textContent = alternative.join(' ');
      swap.title = 'Autre lecture proposée — appuyez pour l\u2019adopter';
      swap.addEventListener('click', () => {
        const previous = parseClues(input.value);
        input.value = swap.textContent;
        swap.textContent = previous.join(' ');
        onChange(i, parseClues(input.value));
        updateSums();
      });
      wrap.append(swap);
    }
    container.append(wrap);
  });
}

function sumOf(clues) {
  return clues.reduce((a, line) => a + line.reduce((x, y) => x + y, 0), 0);
}

function updateSums() {
  const sr = sumOf(state.rowClues);
  const sc = sumOf(state.colClues);
  el.rowsSum.textContent = `(total ${sr})`;
  el.colsSum.textContent = `(total ${sc})`;
  const doubts = state.doubt.rows.size + state.doubt.cols.size;
  const bits = [];
  if (sr === 0 && sc === 0) bits.push('Saisissez les indices de chaque ligne et de chaque colonne.');
  else if (sr === sc) bits.push(`Sommes cohérentes : ${sr} cases à noircir.`);
  else bits.push(`Sommes différentes : ${sr} (lignes) contre ${sc} (colonnes) — il reste une erreur.`);
  if (doubts) bits.push(`${doubts} ligne(s) où les deux lectures divergent (surlignées).`);
  el.sumStatus.textContent = bits.join(' ');
  el.sumStatus.className =
    'status ' + (sr === 0 ? 'warn' : sr === sc ? (doubts ? 'warn' : 'ok') : 'bad');
}

function resizePuzzle(rows, cols) {
  const fit = (arr, n) => {
    const out = arr.slice(0, n);
    while (out.length < n) out.push([]);
    return out;
  };
  state.rows = rows;
  state.cols = cols;
  state.rowClues = fit(state.rowClues, rows);
  state.colClues = fit(state.colClues, cols);
  state.doubt.rows = new Set([...state.doubt.rows].filter((i) => i < rows));
  state.doubt.cols = new Set([...state.doubt.cols].filter((i) => i < cols));
  state.alt.rows = new Map([...state.alt.rows].filter(([i]) => i < rows));
  state.alt.cols = new Map([...state.alt.cols].filter(([i]) => i < cols));
  buildEditor();
}

/* ------------------------------------------------------------- résolution */

function solve() {
  if (!state.rows || !state.cols) return;
  if (sumOf(state.rowClues) === 0 || sumOf(state.colClues) === 0) {
    alert('Aucun indice saisi : remplissez au moins les lignes et les colonnes non vides.');
    return;
  }
  runSolver({}, (result) => {
    if (result.grid && (result.status === 'solved' || result.status === 'ambiguous')) {
      handleResult(result);
      return;
    }
    // Les indices ne se tiennent pas : plutôt que de refuser, on reconstruit
    // ce qui est démontrable en écartant les lignes fautives.
    busy('Reconstruction partielle…', 0.5);
    runSolver(
      {
        mode: 'partial',
        options: {
          timeLimitMs: 20000,
          doubtRows: [...state.doubt.rows],
          doubtCols: [...state.doubt.cols],
        },
      },
      (partial) => handleResult(partial)
    );
  });
}

/** Lance le solveur dans son worker et rend la main au rappel. */
function runSolver({ mode, options }, done) {
  if (solverWorker) solverWorker.terminate();
  solverWorker = new Worker(new URL('./solver-worker.js', import.meta.url), { type: 'module' });
  busy(mode === 'partial' ? 'Reconstruction partielle…' : 'Résolution…', 0.1);

  solverWorker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      busy(`Résolution… (${msg.nodes} hypothèses)`, Math.min(0.95, 0.1 + msg.nodes / 4000));
      return;
    }
    idle();
    solverWorker.terminate();
    solverWorker = null;
    if (msg.type === 'error') {
      alert(`Erreur du solveur : ${msg.message}`);
      return;
    }
    done(msg.result);
  };

  solverWorker.postMessage({
    rowClues: state.rowClues,
    colClues: state.colClues,
    mode,
    options: options || { timeLimitMs: 30000, uniqueCheckMs: 4000, maxSolutions: 2 },
  });
}

function handleResult(result) {
  if (result.status === 'partial') {
    if (!result.grid) {
      alert('Les indices se contredisent et rien n\u2019a pu être reconstruit.');
      return;
    }
    state.solution = result.grid;
    state.rows = result.rows;
    state.cols = result.cols;
    const pct = Math.round((result.determined / result.total) * 100);
    const écartées = [
      result.relaxedRows.length ? `L${result.relaxedRows.map((i) => i + 1).join(', L')}` : '',
      result.relaxedCols.length ? `C${result.relaxedCols.map((j) => j + 1).join(', C')}` : '',
    ].filter(Boolean).join(' et ');

    el.resultStatus.textContent = result.weak
      ? `Reconstruction fragile : il a fallu écarter trop d\u2019indices (${écartées}). ` +
        'L\u2019image ci-dessous respecte ce qui reste, mais ce n\u2019est probablement pas celle de la grille. ' +
        'Corrigez les lignes surlignées, puis relancez.'
      : `Reconstruction partielle : ${pct} % des cases sont déterminées` +
        (écartées ? `, en écartant ${écartées}` : '') +
        '. Les cases grises restent indéterminées.';
    el.resultStatus.className = 'status ' + (result.weak ? 'bad' : 'warn');
    showResult();
    return;
  }

  if (result.status === 'invalid' || result.status === 'contradiction') {
    state.solution = result.partial || null;
    if (!state.solution) {
      alert(`${result.message}\n\nVérifiez les indices surlignés.`);
      return;
    }
  }
  if (result.status === 'timeout' && !result.grid) {
    state.solution = result.partial || null;
    if (!state.solution) {
      alert('Temps de calcul dépassé sans solution. Vérifiez les indices.');
      return;
    }
  }
  if (result.grid) state.solution = result.grid;
  state.rows = result.rows ?? state.rows;
  state.cols = result.cols ?? state.cols;

  const messages = {
    solved: result.uniquenessVerified
      ? 'Solution unique trouvée.'
      : 'Solution trouvée (unicité non vérifiée dans le temps imparti).',
    ambiguous: 'Plusieurs solutions possibles : une erreur de lecture est probable. Une solution est affichée.',
    contradiction: 'Indices contradictoires — seules les déductions certaines sont affichées.',
    timeout: 'Temps dépassé — seules les déductions certaines sont affichées.',
    invalid: result.message,
  };
  el.resultStatus.textContent = messages[result.status] || result.message || '';
  el.resultStatus.className =
    'status ' + (result.status === 'solved' ? 'ok' : result.status === 'ambiguous' ? 'warn' : 'bad');
  showResult();
}

/** Prépare l'écran de résultat, en inventant un cadre si l'on n'a pas de photo. */
function showResult() {
  if (!state.quad) {
    const size = 600;
    state.quad = [
      { x: 0, y: 0 },
      { x: size, y: 0 },
      { x: size, y: (size * state.rows) / state.cols },
      { x: 0, y: (size * state.rows) / state.cols },
    ];
    state.useQuad = true;
    el.chkPhoto.checked = false;
    el.chkPhoto.disabled = !state.photo;
  }
  show('result');
  drawResult();
}

/* ------------------------------------------------------- rendu du résultat */

function drawResult() {
  const canvas = el.resultCanvas;
  const usePhoto = el.chkPhoto.checked && state.photo;
  if (usePhoto) {
    const maxW = Math.min(window.innerWidth - 16, 1000);
    const scale = Math.min(1, maxW / state.photo.width);
    canvas.width = Math.round(state.photo.width * scale);
    canvas.height = Math.round(state.photo.height * scale);
    overlay.renderOverlay({
      ctx: canvas.getContext('2d'),
      photo: state.photo,
      map: currentMapper(),
      grid: state.solution,
      rows: state.rows,
      cols: state.cols,
      opacity: Number(el.opacity.value) / 100,
      showHandles: el.chkAdjust.checked,
    });
  } else {
    const cell = Math.max(8, Math.min(22, Math.floor((window.innerWidth - 60) / state.cols)));
    overlay.renderCleanGrid(canvas, state.solution, state.rows, state.cols, cell);
  }
}

/* ------------------------------------------ ajustement manuel des coins */

function setupCornerDrag() {
  const canvas = el.resultCanvas;
  let dragging = -1;

  const toPhoto = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * state.photo.width;
    const y = ((ev.clientY - rect.top) / rect.height) * state.photo.height;
    return { x, y };
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!el.chkAdjust.checked || !state.photo) return;
    const p = toPhoto(ev);
    let best = -1;
    let bestD = Infinity;
    state.quad.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = i; }
    });
    const tolerance = state.photo.width * 0.12;
    if (bestD > tolerance) return;
    state.useQuad = true;
    dragging = best;
    canvas.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (dragging < 0) return;
    const p = toPhoto(ev);
    state.quad[dragging] = {
      x: Math.max(0, Math.min(state.photo.width, p.x)),
      y: Math.max(0, Math.min(state.photo.height, p.y)),
    };
    drawResult();
    ev.preventDefault();
  });

  const end = () => { dragging = -1; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
}

/* ------------------------------------------------------------ évènements */

$('btn-shoot').addEventListener('click', async () => {
  if (!el.video.videoWidth) return;
  const snap = vision.toWorkingCanvas(el.video, 2400);
  camera.stop();
  await analyze(snap);
});

el.fileInput.addEventListener('change', async () => {
  const file = el.fileInput.files && el.fileInput.files[0];
  if (!file) return;
  busy('Ouverture de l’image…', 0.02);
  const bitmap = await createImageBitmap(file);
  const snap = vision.toWorkingCanvas(bitmap, 2400);
  bitmap.close && bitmap.close();
  el.fileInput.value = '';
  await analyze(snap);
});

$('btn-flip').addEventListener('click', () => camera.flip(el.video).catch(() => {}));

let torchOn = false;
$('btn-torch').addEventListener('click', async () => {
  torchOn = !torchOn;
  const ok = await camera.setTorch(torchOn);
  if (!ok) torchOn = false;
  $('btn-torch').textContent = torchOn ? 'Lampe ✓' : 'Lampe';
});

$('btn-manual').addEventListener('click', () => {
  const cols = parseInt(prompt('Nombre de colonnes ?', state.cols || 20), 10);
  if (!cols || cols < 1 || cols > 80) return;
  const rows = parseInt(prompt('Nombre de lignes ?', state.rows || 20), 10);
  if (!rows || rows < 1 || rows > 80) return;
  camera.stop();
  state.photo = null;
  state.mesh = null;
  state.split = null;
  state.quad = null;
  state.useQuad = false;
  state.rowClues = Array.from({ length: rows }, () => []);
  state.colClues = Array.from({ length: cols }, () => []);
  state.doubt.rows = new Set();
  state.doubt.cols = new Set();
  state.alt.rows = new Map();
  state.alt.cols = new Map();
  state.images.rows = [];
  state.images.cols = [];
  state.rows = rows;
  state.cols = cols;
  el.detectCanvas.width = el.detectCanvas.height = 0;
  buildEditor();
  show('review');
});

$('btn-resize').addEventListener('click', () => {
  const rows = parseInt(el.inRows.value, 10);
  const cols = parseInt(el.inCols.value, 10);
  if (!rows || !cols || rows < 1 || cols < 1 || rows > 80 || cols > 80) return;
  resizePuzzle(rows, cols);
});

$('btn-back-capture').addEventListener('click', () => show('capture'));
$('btn-solve').addEventListener('click', solve);
$('btn-back-review').addEventListener('click', () => show('review'));
$('btn-restart').addEventListener('click', () => {
  state.solution = null;
  show('capture');
});

$('btn-cancel').addEventListener('click', () => {
  cancelled = true;
  if (solverWorker) { solverWorker.terminate(); solverWorker = null; }
  idle();
});

el.opacity.addEventListener('input', drawResult);
el.chkPhoto.addEventListener('change', drawResult);
el.chkAdjust.addEventListener('change', drawResult);

$('btn-download').addEventListener('click', () => {
  el.resultCanvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nonogramme-solution.png';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }, 'image/png');
});

$('btn-help').addEventListener('click', () => $('help').showModal());

window.addEventListener('resize', () => {
  if (el.screens.review.classList.contains('active')) drawDetection();
  if (el.screens.result.classList.contains('active') && state.solution) drawResult();
});

/* ------------------------------------------------------ installation PWA */

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $('btn-install').hidden = false;
});
$('btn-install').addEventListener('click', async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $('btn-install').hidden = true;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(new URL('../sw.js', import.meta.url)).catch(() => {});
  });
}

setupCornerDrag();
show('capture');
