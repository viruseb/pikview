/**
 * Solveur de nonogramme (picross / hanjie).
 *
 * Représentation d'une grille : Int8Array de rows*cols.
 *   UNKNOWN = -1, EMPTY = 0, FILLED = 1
 *
 * Stratégie : propagation de contraintes ligne par ligne (résolution exacte
 * d'une ligne par programmation dynamique) jusqu'au point fixe, puis
 * recherche avec retour arrière sur la ligne la plus contrainte.
 */

export const UNKNOWN = -1;
export const EMPTY = 0;
export const FILLED = 1;

/**
 * Résout une ligne isolée.
 * @param {number[]} clues indices du nonogramme pour cette ligne
 * @param {Int8Array} line état courant (lecture seule)
 * @param {Int8Array} out buffer de sortie (même longueur)
 * @returns {boolean} false si la ligne est contradictoire
 */
export function solveLine(clues, line, out) {
  const n = line.length;
  const k = clues.length;
  const W = n + 2;

  // noFilledFrom[j] : aucune case FILLED dans line[j..n-1]
  const noFilledFrom = new Uint8Array(n + 2);
  noFilledFrom[n] = 1;
  noFilledFrom[n + 1] = 1;
  for (let j = n - 1; j >= 0; j--) {
    noFilledFrom[j] = line[j] !== FILLED ? noFilledFrom[j + 1] : 0;
  }

  // emptyPrefix pour tester qu'un bloc peut être posé sur [a,b)
  const emptyPrefix = new Int32Array(n + 1);
  for (let j = 0; j < n; j++) {
    emptyPrefix[j + 1] = emptyPrefix[j] + (line[j] === EMPTY ? 1 : 0);
  }
  const canFill = (a, b) => emptyPrefix[b] - emptyPrefix[a] === 0;

  // fit(i, j) : les indices clues[i..] tiennent dans line[j..]
  const memo = new Int8Array((k + 1) * W).fill(-1);
  const stack = new Int32Array((k + 1) * W);

  function fit(i, j) {
    if (j > n + 1) return false;
    const key = i * W + j;
    const cached = memo[key];
    if (cached !== -1) return cached === 1;
    let res = false;
    if (i === k) {
      res = j > n ? true : noFilledFrom[j] === 1;
    } else {
      // A : laisser la case j vide
      if (j < n && line[j] !== FILLED && fit(i, j + 1)) res = true;
      // B : poser le bloc i à partir de j
      if (!res) {
        const len = clues[i];
        if (
          j + len <= n &&
          canFill(j, j + len) &&
          (j + len === n || line[j + len] !== FILLED) &&
          fit(i + 1, j + len + 1)
        ) {
          res = true;
        }
      }
    }
    memo[key] = res ? 1 : 0;
    return res;
  }

  if (!fit(0, 0)) return false;

  const possFilled = new Uint8Array(n);
  const possEmpty = new Uint8Array(n);
  const seen = new Uint8Array((k + 1) * W);
  let sp = 0;
  stack[sp++] = 0;
  seen[0] = 1;

  while (sp > 0) {
    const state = stack[--sp];
    const i = (state / W) | 0;
    const j = state % W;
    if (i === k) {
      for (let t = j; t < n; t++) possEmpty[t] = 1;
      continue;
    }
    if (j < n && line[j] !== FILLED && fit(i, j + 1)) {
      possEmpty[j] = 1;
      const key = i * W + (j + 1);
      if (!seen[key]) { seen[key] = 1; stack[sp++] = key; }
    }
    const len = clues[i];
    if (
      j + len <= n &&
      canFill(j, j + len) &&
      (j + len === n || line[j + len] !== FILLED) &&
      fit(i + 1, j + len + 1)
    ) {
      for (let t = j; t < j + len; t++) possFilled[t] = 1;
      if (j + len < n) possEmpty[j + len] = 1;
      const key = (i + 1) * W + (j + len + 1);
      if (j + len + 1 <= n + 1 && !seen[key]) { seen[key] = 1; stack[sp++] = key; }
    }
  }

  for (let j = 0; j < n; j++) {
    if (possFilled[j] && possEmpty[j]) out[j] = UNKNOWN;
    else if (possFilled[j]) out[j] = FILLED;
    else if (possEmpty[j]) out[j] = EMPTY;
    else return false;
  }
  return true;
}

function cluesSum(clues) {
  let s = 0;
  for (const c of clues) s += c;
  return s;
}

function minLength(clues) {
  if (clues.length === 0) return 0;
  return cluesSum(clues) + clues.length - 1;
}

/**
 * Vérifie la cohérence de base des indices avant de lancer la recherche.
 * @returns {string|null} message d'erreur, ou null si tout va bien
 */
/**
 * Vérifie la cohérence de base des indices.
 *
 * Une ligne `null` est sans contrainte : elle est ignorée, et l'égalité des
 * sommes n'est exigée que si toutes les lignes et colonnes sont connues.
 */
export function validateClues(rowClues, colClues) {
  const rows = rowClues.length;
  const cols = colClues.length;
  if (!rows || !cols) return 'Grille vide.';
  for (let r = 0; r < rows; r++) {
    if (rowClues[r] && minLength(rowClues[r]) > cols) {
      return `Ligne ${r + 1} : les indices (${rowClues[r].join(' ')}) ne tiennent pas en ${cols} cases.`;
    }
  }
  for (let c = 0; c < cols; c++) {
    if (colClues[c] && minLength(colClues[c]) > rows) {
      return `Colonne ${c + 1} : les indices (${colClues[c].join(' ')}) ne tiennent pas en ${rows} cases.`;
    }
  }
  if (rowClues.every(Boolean) && colClues.every(Boolean)) {
    const sr = rowClues.reduce((a, x) => a + cluesSum(x), 0);
    const sc = colClues.reduce((a, x) => a + cluesSum(x), 0);
    if (sr !== sc) {
      return `Incohérence : la somme des indices de lignes (${sr}) diffère de celle des colonnes (${sc}).`;
    }
  }
  return null;
}

/**
 * @param {number[][]} rowClues
 * @param {number[][]} colClues
 * @param {{timeLimitMs?:number, maxSolutions?:number, onProgress?:Function}} [opts]
 */
/**
 * Déduit ce qui peut l'être, en écartant les lignes d'indices fautives.
 *
 * Un nonogramme est très surdéterminé : une grille de 25 sur 35 porte soixante
 * contraintes pour huit cent soixante-quinze cases. En jeter quelques-unes
 * laisse presque toute l'image déductible — ce qui vaut mieux que de ne rien
 * montrer parce qu'un « 1 » a été lu « 7 ».
 *
 * Aucune recherche ici, seulement la propagation : les cases qui restent
 * indéterminées le restent, et sont rendues comme telles.
 *
 * Une ligne dont les indices sont contradictoires avec le reste est écartée en
 * cours de route puis signalée — l'algorithme trouve donc lui-même les lignes
 * corrompues, sans qu'on ait à les lui désigner.
 *
 * @param {(number[]|null)[]} rowClues null = ligne sans contrainte
 * @param {(number[]|null)[]} colClues
 * @returns {{grid:Int8Array, rows:number, cols:number, droppedRows:number[],
 *            droppedCols:number[], determined:number, total:number}}
 */
export function deduce(rowClues, colClues, opts = {}) {
  const rows = rowClues.length;
  const cols = colClues.length;
  const timeLimitMs = opts.timeLimitMs ?? 15000;
  const deadline = Date.now() + timeLimitMs;

  // Une ligne trop longue pour tenir est écartée d'emblée.
  const rc = rowClues.map((c) => (c && minLength(c) <= cols ? c : null));
  const cc = colClues.map((c) => (c && minLength(c) <= rows ? c : null));
  const droppedRows = [];
  const droppedCols = [];
  rowClues.forEach((c, i) => { if (c && !rc[i]) droppedRows.push(i); });
  colClues.forEach((c, j) => { if (c && !cc[j]) droppedCols.push(j); });

  const grid = new Int8Array(rows * cols).fill(UNKNOWN);
  const rowBuf = new Int8Array(cols);
  const colBuf = new Int8Array(rows);
  const outBuf = new Int8Array(Math.max(rows, cols));
  const dirtyRows = new Set();
  const dirtyCols = new Set();
  for (let r = 0; r < rows; r++) if (rc[r]) dirtyRows.add(r);
  for (let c = 0; c < cols; c++) if (cc[c]) dirtyCols.add(c);

  while (dirtyRows.size || dirtyCols.size) {
    if (Date.now() > deadline) break;
    if (dirtyRows.size) {
      const r = dirtyRows.values().next().value;
      dirtyRows.delete(r);
      if (!rc[r]) continue;
      const base = r * cols;
      for (let c = 0; c < cols; c++) rowBuf[c] = grid[base + c];
      const out = outBuf.subarray(0, cols);
      if (!solveLine(rc[r], rowBuf, out)) {
        // Contradiction : la ligne est fautive, on s'en passe.
        rc[r] = null;
        droppedRows.push(r);
        continue;
      }
      for (let c = 0; c < cols; c++) {
        if (out[c] !== UNKNOWN && grid[base + c] === UNKNOWN) {
          grid[base + c] = out[c];
          if (cc[c]) dirtyCols.add(c);
        }
      }
      continue;
    }
    const c = dirtyCols.values().next().value;
    dirtyCols.delete(c);
    if (!cc[c]) continue;
    for (let r = 0; r < rows; r++) colBuf[r] = grid[r * cols + c];
    const out = outBuf.subarray(0, rows);
    if (!solveLine(cc[c], colBuf, out)) {
      cc[c] = null;
      droppedCols.push(c);
      continue;
    }
    for (let r = 0; r < rows; r++) {
      if (out[r] !== UNKNOWN && grid[r * cols + c] === UNKNOWN) {
        grid[r * cols + c] = out[r];
        if (rc[r]) dirtyRows.add(r);
      }
    }
  }

  let determined = 0;
  for (const v of grid) if (v !== UNKNOWN) determined++;
  return {
    status: 'partial',
    grid, rows, cols,
    droppedRows: [...new Set(droppedRows)].sort((a, b) => a - b),
    droppedCols: [...new Set(droppedCols)].sort((a, b) => a - b),
    determined,
    total: rows * cols,
  };
}

export function solvePuzzle(rowClues, colClues, opts = {}) {
  const rows = rowClues.length;
  const cols = colClues.length;
  const timeLimitMs = opts.timeLimitMs ?? 20000;
  // Une fois une solution trouvée, on ne consacre qu'un budget réduit à la
  // vérification d'unicité : les vraies grilles publiées sont uniques et
  // l'utilisateur veut sa réponse tout de suite.
  const uniqueCheckMs = opts.uniqueCheckMs ?? 4000;
  const maxSolutions = opts.maxSolutions ?? 2;
  const onProgress = opts.onProgress;
  const started = Date.now();
  let deadline = started + timeLimitMs;

  const invalid = validateClues(rowClues, colClues);
  if (invalid) return { status: 'invalid', message: invalid };

  const rowBuf = new Int8Array(cols);
  const colBuf = new Int8Array(rows);
  const outBuf = new Int8Array(Math.max(rows, cols));

  let timedOut = false;
  let nodes = 0;
  const solutions = [];

  function propagate(grid, dirtyRows, dirtyCols) {
    while (dirtyRows.size || dirtyCols.size) {
      if (Date.now() > deadline) { timedOut = true; return false; }

      if (dirtyRows.size) {
        const r = dirtyRows.values().next().value;
        dirtyRows.delete(r);
        if (!rowClues[r]) continue;
        const base = r * cols;
        for (let c = 0; c < cols; c++) rowBuf[c] = grid[base + c];
        const out = outBuf.subarray(0, cols);
        if (!solveLine(rowClues[r], rowBuf, out)) return false;
        for (let c = 0; c < cols; c++) {
          if (out[c] !== UNKNOWN && grid[base + c] === UNKNOWN) {
            grid[base + c] = out[c];
            dirtyCols.add(c);
          }
        }
        continue;
      }

      const c = dirtyCols.values().next().value;
      dirtyCols.delete(c);
      if (!colClues[c]) continue;
      for (let r = 0; r < rows; r++) colBuf[r] = grid[r * cols + c];
      const out = outBuf.subarray(0, rows);
      if (!solveLine(colClues[c], colBuf, out)) return false;
      for (let r = 0; r < rows; r++) {
        if (out[r] !== UNKNOWN && grid[r * cols + c] === UNKNOWN) {
          grid[r * cols + c] = out[r];
          dirtyRows.add(r);
        }
      }
    }
    return true;
  }

  /** Choisit la ligne (ou colonne) la moins indéterminée pour brancher. */
  function pickCell(grid) {
    let best = -1;
    let bestScore = Infinity;
    for (let r = 0; r < rows; r++) {
      let unknown = 0;
      let first = -1;
      for (let c = 0; c < cols; c++) {
        if (grid[r * cols + c] === UNKNOWN) {
          unknown++;
          if (first < 0) first = r * cols + c;
        }
      }
      if (unknown > 0 && unknown < bestScore) { bestScore = unknown; best = first; }
    }
    for (let c = 0; c < cols; c++) {
      let unknown = 0;
      let first = -1;
      for (let r = 0; r < rows; r++) {
        if (grid[r * cols + c] === UNKNOWN) {
          unknown++;
          if (first < 0) first = r * cols + c;
        }
      }
      if (unknown > 0 && unknown < bestScore) { bestScore = unknown; best = first; }
    }
    return best;
  }

  function search(grid) {
    if (solutions.length >= maxSolutions || timedOut) return;
    const idx = pickCell(grid);
    if (idx < 0) {
      solutions.push(Int8Array.from(grid));
      if (solutions.length === 1) {
        deadline = Math.min(deadline, Date.now() + uniqueCheckMs);
      }
      return;
    }
    nodes++;
    if (onProgress && nodes % 64 === 0) onProgress({ nodes, elapsed: Date.now() - started });
    const r = (idx / cols) | 0;
    const c = idx % cols;
    for (const guess of [FILLED, EMPTY]) {
      if (solutions.length >= maxSolutions || timedOut) return;
      const next = Int8Array.from(grid);
      next[idx] = guess;
      if (propagate(next, new Set([r]), new Set([c]))) search(next);
      if (timedOut) return;
    }
  }

  const grid = new Int8Array(rows * cols).fill(UNKNOWN);
  const dr = new Set();
  const dc = new Set();
  for (let r = 0; r < rows; r++) if (rowClues[r]) dr.add(r);
  for (let c = 0; c < cols; c++) if (colClues[c]) dc.add(c);
  if (!propagate(grid, dr, dc)) {
    return timedOut
      ? { status: 'timeout', message: 'Temps de calcul dépassé.' }
      : { status: 'contradiction', message: 'Aucune solution : les indices se contredisent.' };
  }

  // Copie de l'état après pure déduction : utile pour afficher une solution
  // partielle si la recherche échoue.
  const deduced = Int8Array.from(grid);
  search(grid);

  if (solutions.length === 0) {
    return timedOut
      ? { status: 'timeout', message: 'Temps de calcul dépassé.', partial: deduced, rows, cols }
      : { status: 'contradiction', message: 'Aucune solution : les indices se contredisent.', partial: deduced, rows, cols };
  }

  return {
    status: solutions.length > 1 ? 'ambiguous' : 'solved',
    grid: solutions[0],
    rows,
    cols,
    solutionCount: solutions.length,
    // false : une solution a bien été trouvée, mais le temps a manqué pour
    // prouver qu'elle est la seule.
    uniquenessVerified: solutions.length > 1 || !timedOut,
    solutions,
    exhaustive: !timedOut && solutions.length < maxSolutions,
    elapsed: Date.now() - started,
  };
}

/**
 * Reconstruit ce qui peut l'être quand les indices ne sont pas tous fiables.
 *
 * Une grille de 25 sur 35 porte soixante contraintes pour huit cent
 * soixante-quinze cases : en écarter quelques-unes laisse le reste largement
 * déterminé, et le solveur retrouve souvent jusqu'aux lignes écartées. Mieux
 * vaut donc une image presque complète qu'un refus parce qu'un « 1 » a été lu
 * « 7 ».
 *
 * Les lignes que l'appelant tient pour douteuses sont relâchées d'emblée : ce
 * sont les meilleures candidates, la double lecture ne signalant que des
 * lignes réellement fautives. S'il reste une contradiction, les coupables sont
 * cherchées une à une — relâcher la ligne i suffit-il à rendre la grille
 * cohérente ? Procéder par ordre de propagation ne marchait pas : une ligne
 * fausse empoisonne les colonnes qu'elle croise, et c'étaient les innocentes
 * qui se trouvaient accusées.
 *
 * Ce qui est rendu pour sûr l'est vraiment. Si toutes les solutions du
 * problème relâché ont pu être énumérées, leur intersection est exacte ; sinon
 * on s'en tient à ce que la seule propagation démontre, et les cases qu'elle
 * ne tranche pas restent indéterminées plutôt que devinées.
 *
 * @param {number[][]} rowClues
 * @param {number[][]} colClues
 * @param {{doubtRows?:number[], doubtCols?:number[], timeLimitMs?:number}} [opts]
 */
export function solvePartial(rowClues, colClues, opts = {}) {
  const timeLimitMs = opts.timeLimitMs ?? 20000;
  const deadline = Date.now() + timeLimitMs;
  const relaxRows = new Set(opts.doubtRows || []);
  const relaxCols = new Set(opts.doubtCols || []);

  const build = () => ({
    rows: rowClues.map((c, i) => (relaxRows.has(i) ? null : c)),
    cols: colClues.map((c, j) => (relaxCols.has(j) ? null : c)),
  });
  /** Une grille est jugée cohérente si la propagation n'écarte aucune ligne. */
  const consistent = () => {
    const { rows, cols } = build();
    const probe = deduce(rows, cols, { timeLimitMs: 2000 });
    return probe.droppedRows.length === 0 && probe.droppedCols.length === 0 ? probe : null;
  };

  // Le nombre de lignes qu'on s'autorise à écarter en plus des signalées est
  // borné. Sans cette borne, une seule mauvaise lecture en entraîne une
  // dizaine d'autres, et le problème devient si faible qu'il admet une image
  // entièrement différente — vraie pour les contraintes restantes, fausse pour
  // la grille. Mieux vaut montrer moins de cases que la mauvaise image.
  const maxExtra = opts.maxExtra ?? Math.max(2, Math.round((rowClues.length + colClues.length) * 0.06));
  const initialRelaxed = relaxRows.size + relaxCols.size;

  let probe = consistent();
  for (let round = 0; !probe && round < maxExtra && Date.now() < deadline; round++) {
    const { rows, cols } = build();
    const blamed = deduce(rows, cols, { timeLimitMs: 2000 });
    const candidates = [
      ...blamed.droppedRows.map((i) => ['row', i]),
      ...blamed.droppedCols.map((j) => ['col', j]),
    ];
    if (!candidates.length) break;
    let best = null;
    for (const [kind, index] of candidates) {
      if (Date.now() > deadline) break;
      const set = kind === 'row' ? relaxRows : relaxCols;
      set.add(index);
      const trial = deduce(build().rows, build().cols, { timeLimitMs: 1500 });
      const cost = trial.droppedRows.length + trial.droppedCols.length;
      set.delete(index);
      if (!best || cost < best.cost) best = { kind, index, cost };
      if (cost === 0) break;
    }
    if (!best) break;
    (best.kind === 'row' ? relaxRows : relaxCols).add(best.index);
    probe = consistent();
  }

  const { rows, cols } = build();
  const total = rowClues.length * colClues.length;
  const sûr = probe || deduce(rows, cols, { timeLimitMs: 3000 });
  const extraRelaxed = relaxRows.size + relaxCols.size - initialRelaxed;

  const found = solvePuzzle(rows, cols, {
    timeLimitMs: Math.max(1000, deadline - Date.now()),
    uniqueCheckMs: Math.max(1000, deadline - Date.now()),
    // Relâcher jusqu'à cinq lignes ne laisse qu'une poignée de solutions —
    // trois à dix sur la grille de référence, énumérées en dix millisecondes.
    // La limite doit donc être haute : trop basse, l'énumération n'est jamais
    // complète et l'on retombe sur la seule propagation, bien plus pauvre.
    maxSolutions: opts.maxSolutions ?? 150,
  });

  let grid = sûr.grid;
  let certain = true;
  if (found.exhaustive && found.solutions && found.solutions.length) {
    // Énumération complète : l'intersection est démontrée.
    grid = Int8Array.from(found.solutions[0]);
    for (const other of found.solutions.slice(1)) {
      for (let i = 0; i < grid.length; i++) if (grid[i] !== other[i]) grid[i] = UNKNOWN;
    }
  } else if (found.solutions && found.solutions.length) {
    // Énumération tronquée : on ne retient que ce que la propagation prouve.
    certain = false;
  }

  let determined = 0;
  for (const v of grid) if (v !== UNKNOWN) determined++;
  return {
    status: 'partial',
    grid,
    rows: rowClues.length,
    cols: colClues.length,
    relaxedRows: [...relaxRows].sort((a, b) => a - b),
    relaxedCols: [...relaxCols].sort((a, b) => a - b),
    determined,
    total,
    certain,
    // true : il a fallu écarter plus de lignes que la marge autorisée, ou la
    // grille reste contradictoire. L'image affichée satisfait les contraintes
    // qui restent, mais rien ne dit qu'elle soit celle du puzzle.
    weak: !probe || extraRelaxed >= maxExtra,
  };
}
