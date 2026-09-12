/**
 * Télécharge le moteur Tesseract.js dans `tests/ocr/` pour que le banc de test
 * tourne sans dépendre du réseau à chaque exécution.
 *
 *   node tests/fetch-ocr.mjs
 */
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEST = join(HERE, 'ocr');

const FILES = [
  ['tesseract.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'],
  ['worker.min.js', 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js'],
  // Le moteur tourne en mode LSTM : ce sont ces variantes-là qui sont chargées.
  ['core/tesseract-core-simd-lstm.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-simd-lstm.wasm.js'],
  ['core/tesseract-core-lstm.wasm.js', 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0/tesseract-core-lstm.wasm.js'],
  ['lang/eng.traineddata.gz', 'https://tessdata.projectnaptha.com/4.0.0_fast/eng.traineddata.gz'],
];

for (const [name, url] of FILES) {
  const path = join(DEST, name);
  try {
    const info = await stat(path);
    if (info.size > 0) { console.log(`déjà là   ${name} (${(info.size / 1024).toFixed(0)} Ko)`); continue; }
  } catch { /* à télécharger */ }
  process.stdout.write(`téléchargement ${name}… `);
  const res = await fetch(url);
  if (!res.ok) { console.log(`échec ${res.status}`); process.exitCode = 1; continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  console.log(`${(buf.length / 1024).toFixed(0)} Ko`);
}
