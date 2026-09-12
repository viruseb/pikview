/**
 * Banc de test de la lecture d'une grille photographiée.
 *
 * Fait tourner la vraie chaîne d'analyse (`js/analyze.js`) dans Chromium sur
 * chaque photo de `tests/fixtures/`, et compare aux indices attendus
 * (`<photo>.expected.json`).
 *
 *   node tests/fetch-ocr.mjs        # une fois : récupère le moteur OCR
 *   node tests/bench.mjs            # mesure
 *   node tests/bench.mjs --dump     # affiche les indices lus, ligne par ligne
 *   node tests/bench.mjs --only livre-01
 *
 * Chromium est cherché via PLAYWRIGHT_CHROMIUM, sinon celui de Playwright.
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURES = join(HERE, 'fixtures');

const args = process.argv.slice(2);
const DUMP = args.includes('--dump');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

if (!existsSync(join(HERE, 'ocr', 'tesseract.min.js'))) {
  console.error('Moteur OCR absent. Lancez d’abord : node tests/fetch-ocr.mjs');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.gz': 'application/gzip', '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  const path = join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!path.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { solvePuzzle, validateClues } = await import(new URL('../js/solver.js', import.meta.url));

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'
).catch(() => import('playwright'));

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[erreur page]', e.message));
await page.goto(`${base}/tests/runner.html?ocr=/tests/ocr`);

const files = (await readdir(FIXTURES))
  .filter((f) => f.endsWith('.jpg'))
  .filter((f) => !only || f.includes(only))
  .sort();

const rows = [];
for (const file of files) {
  const t0 = Date.now();
  const got = await page.evaluate(
    ({ url }) => window.runPipeline(url),
    { url: `${base}/tests/fixtures/${file}` }
  );
  const ms = Date.now() - t0;

  let expected = null;
  try {
    expected = JSON.parse(await readFile(join(FIXTURES, file.replace(/\.jpg$/, '.expected.json')), 'utf8'));
    // Plusieurs photos d'une même grille partagent une seule référence.
    if (expected.like) {
      expected = JSON.parse(await readFile(join(FIXTURES, expected.like.replace(/\.jpg$/, '.expected.json')), 'utf8'));
    }
  } catch { /* pas encore de référence */ }

  const line = { file, ms, ...score(got, expected), ...solvability(got) };
  rows.push(line);

  if (DUMP) {
    console.log(`\n=== ${file} ===`);
    console.log(JSON.stringify({ rows: got.rows, cols: got.cols }, null, 0));
    dumpClues('L', got.rowClues, expected && expected.rowClues, got.doubtRows);
    dumpClues('C', got.colClues, expected && expected.colClues, got.doubtCols);
  }
}

console.log('');
console.table(rows);
await browser.close();
server.close();

const failed = rows.filter((r) => r.grid !== 'ok' || (r.lignes && !r.lignes.startsWith(r.lignes.split('/')[1])));
process.exitCode = rows.some((r) => r.grid !== 'ok') ? 1 : 0;

/**
 * Contrôle sans référence : des indices dont les sommes concordent et qui
 * donnent une solution unique sont presque sûrement bien lus. Une grille
 * publiée est unique par construction ; une erreur de lecture la rend
 * contradictoire ou ambiguë presque à coup sûr.
 */
function solvability(got) {
  if (got.error || !got.rowClues.length || !got.colClues.length) return { résolution: '—' };
  const sr = got.rowClues.reduce((a, l) => a + l.reduce((x, y) => x + y, 0), 0);
  const sc = got.colClues.reduce((a, l) => a + l.reduce((x, y) => x + y, 0), 0);
  if (sr !== sc) return { résolution: `sommes ${sr}≠${sc}` };
  const bad = validateClues(got.rowClues, got.colClues);
  if (bad) return { résolution: 'indices invalides' };
  const res = solvePuzzle(got.rowClues, got.colClues, { timeLimitMs: 15000, uniqueCheckMs: 3000 });
  return { résolution: res.status === 'solved' ? '✓ unique' : res.status };
}

function same(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

function score(got, expected) {
  if (got.error) return { grid: got.error, lignes: '', colonnes: '', signalé: '' };
  if (!expected) {
    return {
      grid: `${got.cols}x${got.rows} bloc ${got.clueCols}x${got.clueRows}`,
      lignes: `? (${got.rowClues.length})`,
      colonnes: `? (${got.colClues.length})`,
      signalé: `${got.doubtRows.length + got.doubtCols.length}`,
    };
  }
  const gridOk = got.rows === expected.rows && got.cols === expected.cols;
  const hasRows = Array.isArray(expected.rowClues);
  const hasCols = Array.isArray(expected.colClues);
  const rOk = gridOk && hasRows ? got.rowClues.filter((c, i) => same(c, expected.rowClues[i])).length : 0;
  const cOk = gridOk && hasCols ? got.colClues.filter((c, i) => same(c, expected.colClues[i])).length : 0;
  // Combien de lignes fausses l'application a-t-elle effectivement signalées ?
  const wrongR = hasRows
    ? got.rowClues.map((c, i) => !same(c, expected.rowClues[i] || [])).map((bad, i) => bad && !got.doubtRows.includes(i))
    : [];
  const wrongC = hasCols
    ? got.colClues.map((c, i) => !same(c, expected.colClues[i] || [])).map((bad, i) => bad && !got.doubtCols.includes(i))
    : [];
  return {
    grid: gridOk ? `ok bloc ${got.clueCols}x${got.clueRows}` : `${got.cols}x${got.rows} ≠ ${expected.cols}x${expected.rows}`,
    lignes: hasRows ? `${rOk}/${expected.rows}` : '—',
    colonnes: hasCols ? `${cOk}/${expected.cols}` : '—',
    'fausses non signalées': wrongR.filter(Boolean).length + wrongC.filter(Boolean).length,
  };
}

function dumpClues(prefix, got, expected, doubt) {
  got.forEach((clues, i) => {
    const exp = expected && expected[i];
    const ok = exp ? same(clues, exp) : null;
    const flag = doubt.includes(i) ? '⚠' : ' ';
    const mark = ok === null ? ' ' : ok ? ' ' : '✗';
    const ref = ok === false ? `   attendu : ${exp.join(' ')}` : '';
    console.log(` ${flag}${mark} ${prefix}${String(i + 1).padEnd(3)} ${clues.join(' ').padEnd(26)}${ref}`);
  });
}
