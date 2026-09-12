/* Worker dédié au solveur : garde l'interface fluide pendant la recherche. */
import { solvePuzzle } from './solver.js';

self.onmessage = (e) => {
  const { rowClues, colClues, options } = e.data;
  try {
    const result = solvePuzzle(rowClues, colClues, {
      ...options,
      onProgress: (p) => self.postMessage({ type: 'progress', ...p }),
    });
    // Les Int8Array passent par structured clone sans souci.
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.message || err) });
  }
};
