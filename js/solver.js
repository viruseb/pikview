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
export function validateClues(rowClues, colClues) {
  const rows = rowClues.length;
  const cols = colClues.length;
  if (!rows || !cols) return 'Grille vide.';
  for (let r = 0; r < rows; r++) {
    if (minLength(rowClues[r]) > cols) {
      return `Ligne ${r + 1} : les indices (${rowClues[r].join(' ')}) ne tiennent pas en ${cols} cases.`;
    }
  }
  for (let c = 0; c < cols; c++) {
    if (minLength(colClues[c]) > rows) {
      return `Colonne ${c + 1} : les indices (${colClues[c].join(' ')}) ne tiennent pas en ${rows} cases.`;
    }
  }
  const sr = rowClues.reduce((a, x) => a + cluesSum(x), 0);
  const sc = colClues.reduce((a, x) => a + cluesSum(x), 0);
  if (sr !== sc) {
    return `Incohérence : la somme des indices de lignes (${sr}) diffère de celle des colonnes (${sc}).`;
  }
  return null;
}

/**
 * @param {number[][]} rowClues
 * @param {number[][]} colClues
 * @param {{timeLimitMs?:number, maxSolutions?:number, onProgress?:Function}} [opts]
 */
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
  for (let r = 0; r < rows; r++) dr.add(r);
  for (let c = 0; c < cols; c++) dc.add(c);
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
    elapsed: Date.now() - started,
  };
}
