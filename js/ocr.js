/**
 * Reconnaissance des chiffres via Tesseract.js, chargé à la demande depuis un
 * CDN. Si le chargement échoue (hors ligne au premier usage), l'appelant
 * bascule sur la saisie manuelle.
 */

// Par défaut le moteur vient d'un CDN, ce qui garde le dépôt léger. Pour une
// application entièrement autonome (hors ligne dès la première utilisation),
// déposez les fichiers de tesseract.js à côté du site et ouvrez la page avec
// `?ocr=chemin/du/dossier` ; le dossier doit contenir `tesseract.min.js`,
// `worker.min.js`, un sous-dossier `core/` (tesseract.js-core, au minimum les
// variantes `tesseract-core-simd-lstm.wasm.js` et `tesseract-core-lstm.wasm.js`
// puisque le moteur est lancé en mode LSTM) et `lang/` (eng.traineddata.gz).
const CDN = {
  js: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  worker: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
  core: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.0',
  // Jeu « fast » : 2 Mo au lieu de 11, largement suffisant pour des chiffres.
  lang: 'https://tessdata.projectnaptha.com/4.0.0_fast',
};

function endpoints() {
  const base = new URLSearchParams(location.search).get('ocr');
  if (!base) return CDN;
  const root = base.replace(/\/+$/, '');
  return {
    js: `${root}/tesseract.min.js`,
    worker: `${root}/worker.min.js`,
    core: `${root}/core`,
    lang: `${root}/lang`,
  };
}

let scriptPromise = null;
let workerPromise = null;

function loadScript(src) {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (self.Tesseract) return resolve(self.Tesseract);
    const el = document.createElement('script');
    el.src = src;
    el.crossOrigin = 'anonymous';
    el.onload = () => resolve(self.Tesseract);
    el.onerror = () => {
      scriptPromise = null;
      reject(new Error('Impossible de charger le moteur OCR (connexion requise au premier usage).'));
    };
    document.head.appendChild(el);
  });
  return scriptPromise;
}

export async function getWorker(onStatus) {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const urls = endpoints();
    const Tesseract = await loadScript(urls.js);
    const worker = await Tesseract.createWorker('eng', 1, {
      workerPath: urls.worker,
      corePath: urls.core,
      langPath: urls.lang,
      gzip: true,
      logger: (m) => {
        if (onStatus && m.status) onStatus(m);
      },
    });
    await worker.setParameters({
      tessedit_char_whitelist: '0123456789',
      tessedit_pageseg_mode: '7', // une seule ligne de texte
      classify_bln_numeric_mode: '1',
    });
    return worker;
  })();
  workerPromise = workerPromise.catch((err) => {
    workerPromise = null;
    throw err instanceof Error
      ? err
      : new Error('Moteur de reconnaissance indisponible (chargement interrompu).');
  });
  return workerPromise;
}

/** Aplatit l'arborescence blocs → paragraphes → lignes → mots → symboles. */
function collectSymbols(data) {
  const out = [];
  for (const block of data.blocks || []) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        for (const word of line.words || []) {
          for (const sym of word.symbols || []) out.push(sym);
          if (!(word.symbols || []).length && word.text) out.push(word);
        }
      }
    }
  }
  return out;
}

/**
 * Lit une bande composée par `composeStrip` et rend un nombre par case.
 *
 * Chaque caractère reconnu est réaffecté à la case dont il occupe
 * l'emplacement : l'OCR n'a pas à deviner où couper.
 *
 * @param {{canvas:HTMLCanvasElement, slots:{x0:number,x1:number}[]}} strip
 * @returns {Promise<{values:(number|null)[], confidence:number, minConfidence:number}>}
 */
export async function readStrip(worker, strip) {
  const values = strip.slots.map(() => null);
  if (!strip.slots.length) return { values, confidence: 100, minConfidence: 100 };

  const { data } = await worker.recognize(strip.canvas, {}, { blocks: true, text: true });
  const symbols = collectSymbols(data).filter((s) => /[0-9]/.test(s.text || ''));

  const buckets = strip.slots.map(() => []);
  for (const sym of symbols) {
    const box = sym.bbox || {};
    const cx = (box.x0 + box.x1) / 2;
    let target = -1;
    if (Number.isFinite(cx)) {
      target = strip.slots.findIndex((s) => cx >= s.x0 && cx < s.x1);
    }
    if (target < 0) continue;
    buckets[target].push({ x: box.x0, text: (sym.text || '').replace(/[^0-9]/g, ''), conf: sym.confidence ?? 0 });
  }

  let confSum = 0;
  let confCount = 0;
  let confMin = 100;
  buckets.forEach((bucket, i) => {
    if (!bucket.length) return;
    bucket.sort((a, b) => a.x - b.x);
    const digits = bucket.map((b) => b.text).join('');
    const n = parseInt(digits, 10);
    if (Number.isFinite(n) && n > 0) values[i] = n;
    for (const b of bucket) { confSum += b.conf; confCount++; confMin = Math.min(confMin, b.conf); }
  });

  // Repli : si le découpage par position n'a rien donné (aucune boîte
  // fournie), on retombe sur le texte brut séparé par les espaces.
  if (values.every((v) => v === null) && data.text) {
    const nums = data.text.split(/\s+/).map((t) => parseInt(t.replace(/[^0-9]/g, ''), 10)).filter((n) => n > 0);
    if (nums.length === values.length) nums.forEach((n, i) => { values[i] = n; });
  }

  return {
    values,
    confidence: confCount ? confSum / confCount : 0,
    minConfidence: confCount ? confMin : 0,
  };
}

export async function terminate() {
  if (!workerPromise) return;
  try {
    const w = await workerPromise;
    await w.terminate();
  } catch { /* rien à faire */ }
  workerPromise = null;
}
