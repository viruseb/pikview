/**
 * Mesure la localisation des blocs d'indices par densité d'encre.
 *
 * Cherche, sur chaque photo de `tests/fixtures/`, le L formé par les deux
 * blocs d'indices, et en déduit les dimensions du nonogramme — sans passer par
 * l'étendue du tableau, qui est ce qui échoue aujourd'hui.
 *
 *   node tests/blocs.mjs                 # mesure
 *   node tests/blocs.mjs --carte         # affiche la carte de densité
 *   node tests/blocs.mjs --seuil 0.13    # autre seuil d'encre
 *   node tests/blocs.mjs --only livre-47
 *
 * N'utilise pas le moteur OCR : seule la géométrie est en jeu.
 * Chromium est cherché via PLAYWRIGHT_CHROMIUM, sinon celui de Playwright.
 */
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURES = join(HERE, 'fixtures');

const args = process.argv.slice(2);
const CARTE = args.includes('--carte');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const SEUIL = args.includes('--seuil') ? Number(args[args.indexOf('--seuil') + 1]) : 0.1;

/**
 * Dimensions relevées à la main sur les photos, en colonnes × lignes.
 *
 * Attention à l'ordre : le banc affiche `35x25` pour livre-47 avec « colonnes
 * 35 » et « lignes 25 », donc cette grille fait 35 colonnes sur 45 lignes.
 * L'avoir noté à l'envers une première fois avait transformé une réussite en
 * échec dans le tableau de mesure.
 */
const ATTENDU = {
  'livre-01-plat': [25, 35],
  'livre-02-courbe': [25, 35],
  'livre-03-incline': [25, 35],
  'livre-04-perspective': [25, 35],
  'livre-45-oeuvre': [35, 45],
  'livre-47-profondeurs': [35, 45],
  'manuscrit-papier-regle': [20, 30],
};

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
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

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'
).catch(() => import('playwright'));

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[erreur page]', e.message));
await page.goto(`${base}/index.html`);

/** Densité d'encre case par case, sur une trame régulière couvrant la photo aplatie. */
async function densites(nom) {
  return page.evaluate(async (photo) => {
    const vision = await import('/js/vision.js');
    const { fitModel, modelRange, flattenByModel } = await import('/js/rectify.js');
    const CELL = 26;
    const img = new Image();
    img.src = `/tests/fixtures/${photo}.jpg`;
    await img.decode();
    const work = vision.toWorkingCanvas(img, 1400);
    const { gray, w, h } = vision.toGray(work);
    const ink = vision.adaptiveThreshold(gray, w, h, Math.max(8, Math.round(Math.min(w, h) / 45)), 9);
    const mesh = vision.detectMesh(ink, w, h);
    if (!mesh) return { erreur: 'maillage' };
    const model = fitModel(mesh);
    if (!model) return { erreur: 'modèle' };
    const flat = flattenByModel(work, model, modelRange(model, w, h), CELL);
    if (!flat) return { erreur: 'aplatissement' };
    const g = vision.toGray(flat.canvas);
    const flatInk = vision.adaptiveThreshold(g.gray, g.w, g.h, Math.max(8, Math.round(Math.min(g.w, g.h) / 45)), 9);
    // La marge écarte le quadrillage lui-même : sans elle, chaque case porte de
    // l'encre et la zone de jeu cesse d'être vide.
    const marge = Math.round(CELL * 0.22);
    const R = Math.floor(g.h / CELL);
    const C = Math.floor(g.w / CELL);
    const dens = [];
    for (let i = 0; i < R; i++) {
      const ligne = [];
      for (let j = 0; j < C; j++) {
        let encre = 0;
        let total = 0;
        for (let y = i * CELL + marge; y < (i + 1) * CELL - marge; y++) {
          for (let x = j * CELL + marge; x < (j + 1) * CELL - marge; x++) {
            total++;
            if (flatInk[y * g.w + x]) encre++;
          }
        }
        ligne.push(total ? encre / total : 0);
      }
      dens.push(ligne);
    }
    return { R, C, dens };
  }, nom);
}

/**
 * Coin intérieur du L : le coin haut-gauche du plus grand rectangle vide ayant
 * de l'encre juste au-dessus et juste à sa gauche.
 *
 * La double condition est ce qui distingue la zone de jeu d'une marge de page,
 * qui est vide elle aussi mais que rien ne borde.
 */
function coinInterieur(dens, R, C, seuil) {
  const vide = (i, j) => dens[i][j] < seuil;
  const encre = (i, j) => dens[i][j] >= seuil;
  const haut = new Int32Array(C);
  let best = null;
  for (let i = 0; i < R; i++) {
    for (let j = 0; j < C; j++) haut[j] = vide(i, j) ? haut[j] + 1 : 0;
    const pile = [];
    for (let j = 0; j <= C; j++) {
      const cur = j < C ? haut[j] : 0;
      while (pile.length && haut[pile[pile.length - 1]] >= cur) {
        const t = pile.pop();
        const gauche = pile.length ? pile[pile.length - 1] + 1 : 0;
        const hh = haut[t];
        const largeur = j - gauche;
        if (hh < 4 || largeur < 4) continue;
        const sr = i - hh + 1;
        const sc = gauche;
        if (sr === 0 || sc === 0) continue;
        let dessus = 0;
        for (let x = sc; x < sc + largeur; x++) if (encre(sr - 1, x)) dessus++;
        let cote = 0;
        for (let y = sr; y < sr + hh; y++) if (encre(y, sc - 1)) cote++;
        if (dessus < largeur * 0.5 || cote < hh * 0.5) continue;
        const aire = hh * largeur;
        if (!best || aire > best.aire) best = { aire, sr, sc };
      }
      pile.push(j);
    }
  }
  return best;
}

/**
 * Étendue d'un bloc d'indices, suivie sur la seule rangée — ou colonne — qui
 * borde la coupure.
 *
 * Les indices sont alignés contre la grille : le dernier indice d'une ligne
 * touche la coupure. Suivre la bande entière reviendrait à la prolonger au
 * premier artefact venu — c'est ce qui donnait 31 colonnes au lieu de 25 sur
 * livre-02.
 */
function suivre(depart, limite, present) {
  let fin = depart;
  let manques = 0;
  for (let k = depart; k < limite; k++) {
    if (present(k)) { fin = k + 1; manques = 0; }
    else if (++manques > 1) break;
  }
  return fin;
}

const files = (await readdir(FIXTURES))
  .filter((f) => f.endsWith('.jpg'))
  .filter((f) => !only || f.includes(only))
  .sort();

const lignes = [];
for (const file of files) {
  const nom = file.replace(/\.jpg$/, '');
  const d = await densites(nom);
  if (d.erreur) { lignes.push({ photo: nom, trouvé: '—', note: d.erreur }); continue; }
  const { R, C, dens } = d;

  if (CARTE) {
    console.log(`\n=== ${nom}   trame ${R} × ${C}`);
    for (let i = 0; i < R; i++) {
      console.log(String(i).padStart(3) + ' ' + dens[i].map((v) => (v >= 0.2 ? '#' : v >= SEUIL ? '+' : ' ')).join('') + '|');
    }
  }

  const coin = coinInterieur(dens, R, C, SEUIL);
  if (!coin) { lignes.push({ photo: nom, trouvé: '—', note: 'pas de coin' }); continue; }
  const { sr, sc } = coin;
  const encre = (i, j) => dens[i][j] >= SEUIL;
  const r1 = suivre(sr, R, (i) => encre(i, sc - 1) || (sc > 1 && encre(i, sc - 2)));
  const c1 = suivre(sc, C, (j) => encre(sr - 1, j) || (sr > 1 && encre(sr - 2, j)));

  // Les grilles publiées ont des côtés multiples de cinq, et les mesures brutes
  // tombent à deux cases près : l'arrondi tranche, il ne masque pas un écart.
  const rond = (n) => Math.round(n / 5) * 5;
  const cols = rond(c1 - sc);
  const rows = rond(r1 - sr);
  const attendu = ATTENDU[nom];
  lignes.push({
    photo: nom,
    coin: `${sr},${sc}`,
    brut: `${c1 - sc}×${r1 - sr}`,
    trouvé: `${cols}×${rows}`,
    attendu: attendu ? `${attendu[0]}×${attendu[1]}` : '?',
    note: attendu ? (cols === attendu[0] && rows === attendu[1] ? 'ok' : 'FAUX') : '',
  });
}

console.table(lignes);
const connus = lignes.filter((l) => l.note === 'ok' || l.note === 'FAUX');
console.log(`${connus.filter((l) => l.note === 'ok').length}/${connus.length} justes (seuil d'encre ${SEUIL})`);

await browser.close();
server.close();
